import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { backfillLearningEmbeddings } from "../../embeddings/backfill-learning-embeddings.js";
import { renderLearningsIndexSection } from "../../planning/learnings-index.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;
const MODEL = "fake-embedder-v1";
const SCOPE = ["shared"];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createDb = async () => {
  const tempDir = await createTempDir("foreman-archive-test-");
  cleanupDirs.push(tempDir);
  return createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
};

type DbHandle = Awaited<ReturnType<typeof createMigratedDb>>;

const seed = (db: DbHandle, input: { id: string; content: string; vector?: readonly number[] }): void => {
  db.learnings.addLearning({ id: input.id, title: input.id, repo: "shared", confidence: "emerging", content: input.content, tags: [] });
  if (input.vector) {
    const applied = db.learnings.upsertLearningEmbedding({
      learningId: input.id,
      model: MODEL,
      dims: 3,
      vector: Float32Array.from(input.vector),
      embeddedTitle: input.id,
      embeddedContent: input.content,
    });
    expect(applied).toBe(true);
  }
};

const ftsIds = (db: DbHandle, query: string): string[] =>
  db.learnings.searchLearnings({ queries: [query], repos: SCOPE }).map((record) => record.id);

const recencyIds = (db: DbHandle): string[] => db.learnings.searchLearnings({ repos: SCOPE }).map((record) => record.id);

const hybridIds = (db: DbHandle, query: string, vector: readonly number[]): string[] =>
  db.learnings
    .searchLearningsHybrid({ queries: [query], repos: SCOPE }, { model: MODEL, vectors: [Float32Array.from(vector)] })
    .map((record) => record.id);

const similarIds = (db: DbHandle, vector: readonly number[]): string[] => {
  const result = db.learnings.selectSimilarLearningsCovered(
    { repos: SCOPE, limit: 5 },
    { model: MODEL, vector: Float32Array.from(vector) },
    { minCoverage: 0.5, minSimilarity: 0.5 },
  );
  return result.covered ? result.learnings.map((entry) => entry.learning.id) : [];
};

describe("learning archive substrate", () => {
  test("an archived learning drops out of every retrieval surface it was reaching", async () => {
    const db = await createDb();
    try {
      // learn-target is the bm25 AND cosine winner for the query below; learn-other
      // matches neither, so it stays put and proves the surfaces still answer.
      seed(db, { id: "learn-target", content: "ubuntu lockfile discipline", vector: [1, 0, 0] });
      seed(db, { id: "learn-other", content: "prisma migrate reset", vector: [0, 1, 0] });

      // Non-vacuous: while active, learn-target is the hit each surface returns.
      expect(ftsIds(db, "ubuntu")).toEqual(["learn-target"]);
      expect(recencyIds(db)).toContain("learn-target");
      expect(hybridIds(db, "ubuntu", [1, 0, 0])).toContain("learn-target");
      expect(similarIds(db, [1, 0, 0])).toEqual(["learn-target"]);
      expect(db.learnings.nearestLearningEmbedding(Float32Array.from([1, 0, 0]), { model: MODEL, repos: SCOPE })?.learningId).toBe(
        "learn-target",
      );

      db.learnings.archiveLearning("learn-target");

      // Gone from FTS, the recency listing, hybrid, and similar-injection.
      expect(ftsIds(db, "ubuntu")).toEqual([]);
      expect(recencyIds(db)).toEqual(["learn-other"]);
      expect(hybridIds(db, "ubuntu", [1, 0, 0])).toEqual([]);
      expect(similarIds(db, [1, 0, 0])).toEqual([]);

      // The dedup NN check no longer points a new learning at the archived one,
      // even though its vector is the exact match — it resolves to learn-other.
      expect(db.learnings.nearestLearningEmbedding(Float32Array.from([1, 0, 0]), { model: MODEL, repos: SCOPE })?.learningId).toBe(
        "learn-other",
      );

      // Counts and the embedding readers exclude it from both sides of the gate.
      expect(db.learnings.countLearnings({ repos: SCOPE })).toBe(1);
      expect(db.learnings.countCurrentLearningEmbeddings({ repos: SCOPE, model: MODEL })).toBe(1);
      expect(db.learnings.getCurrentLearningEmbeddings({ repos: SCOPE, model: MODEL }).map((row) => row.learningId)).toEqual([
        "learn-other",
      ]);

      // The browse list hides it by default and shows it (with the stamp) on request.
      expect(db.learnings.listLearnings().map((row) => row.id)).toEqual(["learn-other"]);
      const withArchived = db.learnings.listLearnings({ includeArchived: true });
      expect(withArchived.map((row) => row.id).sort()).toEqual(["learn-other", "learn-target"]);
      expect(withArchived.find((row) => row.id === "learn-target")?.archivedAt).toEqual(expect.any(String));
    } finally {
      db.close();
    }
  });

  test("an archived unembedded row shifts neither side of the coverage gate", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "learn-a", content: "prisma migrate reset", vector: [1, 0, 0] });
      seed(db, { id: "learn-b", content: "workflows declare ubuntu", vector: [0, 1, 0] });
      // Archived AND never embedded: the case that would silently drag coverage
      // down if it were counted in the denominator but not the numerator.
      seed(db, { id: "learn-archived", content: "shelved and unembedded" });
      db.learnings.archiveLearning("learn-archived");

      expect(db.learnings.countLearnings({ repos: SCOPE })).toBe(2);
      expect(db.learnings.countCurrentLearningEmbeddings({ repos: SCOPE, model: MODEL })).toBe(2);
      expect(db.learnings.listLearningIdsMissingEmbedding(MODEL)).toEqual([]);

      // The identity the freshness rule rests on still holds with an archived row present.
      expect(
        db.learnings.countCurrentLearningEmbeddings({ repos: SCOPE, model: MODEL }) +
          db.learnings.listLearningIdsMissingEmbedding(MODEL).length,
      ).toBe(db.learnings.countLearnings({ repos: SCOPE }));

      // Coverage reads a full 2/2; counted, learn-archived would drop it to 2/3
      // and force a shortfall below the 0.9 gate.
      const covered = db.learnings.searchLearningsHybridCovered(
        { queries: ["prisma"], repos: SCOPE },
        { model: MODEL, vectors: [Float32Array.from([1, 0, 0])] },
        { minCoverage: 0.9 },
      );
      expect(covered.covered).toBe(true);
    } finally {
      db.close();
    }
  });

  test("the plan.md learnings index, built from the default listing, omits an archived learning", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "learn-active", content: "active body" });
      seed(db, { id: "learn-archived", content: "archived body" });
      db.learnings.archiveLearning("learn-archived");

      // The production composition: render-workspace-plan feeds `listLearnings()`
      // (no args) straight into `renderLearningsIndexSection` for the plan.md index.
      const section = renderLearningsIndexSection(db.learnings.listLearnings());
      expect(section).toContain("learn-active");
      expect(section).not.toContain("learn-archived");
    } finally {
      db.close();
    }
  });

  test("getLearningsByIds resolves an archived id so an id in hand keeps working", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "learn-x", content: "body" });
      db.learnings.archiveLearning("learn-x");

      const [learning] = db.learnings.getLearningsByIds(["learn-x"]);
      expect(learning?.id).toBe("learn-x");
      expect(learning?.archivedAt).toEqual(expect.any(String));
    } finally {
      db.close();
    }
  });

  test("unarchive restores retrieval, and an update revives an archived learning", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "learn-x", content: "ubuntu runner discipline" });

      db.learnings.archiveLearning("learn-x");
      expect(ftsIds(db, "ubuntu")).toEqual([]);

      db.learnings.unarchiveLearning("learn-x");
      expect(ftsIds(db, "ubuntu")).toEqual(["learn-x"]);
      expect(db.learnings.getLearningsByIds(["learn-x"])[0]?.archivedAt).toBeNull();

      // A worker `update` on an archived learning un-archives it: fresh evidence revives.
      db.learnings.archiveLearning("learn-x");
      expect(ftsIds(db, "ubuntu")).toEqual([]);
      db.learnings.updateLearning({ id: "learn-x", content: "ubuntu runner revived" });
      expect(db.learnings.getLearningsByIds(["learn-x"])[0]?.archivedAt).toBeNull();
      expect(ftsIds(db, "ubuntu")).toEqual(["learn-x"]);
    } finally {
      db.close();
    }
  });

  test("archive and unarchive round-trip the stamp, and reject an unknown id", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "learn-x", content: "body" });
      expect(db.learnings.getLearningsByIds(["learn-x"])[0]?.archivedAt).toBeNull();

      db.learnings.archiveLearning("learn-x");
      expect(db.learnings.getLearningsByIds(["learn-x"])[0]?.archivedAt).toEqual(expect.any(String));

      db.learnings.unarchiveLearning("learn-x");
      expect(db.learnings.getLearningsByIds(["learn-x"])[0]?.archivedAt).toBeNull();

      expect(() => db.learnings.archiveLearning("nope")).toThrow(/Learning not found/);
      expect(() => db.learnings.unarchiveLearning("nope")).toThrow(/Learning not found/);
    } finally {
      db.close();
    }
  });

  test("backfill neither claims nor blocks work on an archived learning", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();
    try {
      seed(db, { id: "learn-active", content: "needs a vector" });
      seed(db, { id: "learn-archived", content: "shelved" });
      db.learnings.archiveLearning("learn-archived");

      const result = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      // Only the active row is owed a vector, embedded, and counted as total.
      expect(result).toMatchObject({ total: 1, embedded: 1, skipped: 0 });
      expect(embedder.embeddedTexts).toEqual(["learn-active\nneeds a vector"]);
      expect(db.learnings.listLearningIdsMissingEmbedding(MODEL)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("flagAndArchiveDuplicates points each loser at its survivor, drops them from retrieval, keeps them resolvable", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "survivor", content: "ubuntu lockfile discipline", vector: [1, 0, 0] });
      seed(db, { id: "loser-a", content: "ubuntu lockfile discipline again", vector: [1, 0, 0] });
      seed(db, { id: "loser-b", content: "ubuntu lockfile discipline once more", vector: [1, 0, 0] });

      db.learnings.flagAndArchiveDuplicates([
        { id: "loser-a", duplicateOf: "survivor" },
        { id: "loser-b", duplicateOf: "survivor" },
      ]);

      // Each loser is archived and flagged, and gone from retrieval.
      for (const id of ["loser-a", "loser-b"]) {
        const [loser] = db.learnings.getLearningsByIds([id]);
        expect(loser?.archivedAt).toEqual(expect.any(String));
        expect(loser?.duplicateOf).toBe("survivor");
      }
      expect(ftsIds(db, "ubuntu")).toEqual(["survivor"]);

      // The survivor is untouched — it duplicates nothing and stays active.
      const [survivor] = db.learnings.getLearningsByIds(["survivor"]);
      expect(survivor?.archivedAt).toBeNull();
      expect(survivor?.duplicateOf).toBeNull();
    } finally {
      db.close();
    }
  });

  test("flagAndArchiveDuplicates rolls the whole batch back rather than stranding an already-archived loser", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "survivor", content: "ubuntu lockfile discipline", vector: [1, 0, 0] });
      seed(db, { id: "loser", content: "ubuntu lockfile discipline again", vector: [1, 0, 0] });

      // A batch whose second entry is unknown must abort atomically: the valid
      // first loser is NOT left archived, so a partial apply cannot strand a
      // transitive-chain member the re-scan would never re-cluster.
      expect(() =>
        db.learnings.flagAndArchiveDuplicates([
          { id: "loser", duplicateOf: "survivor" },
          { id: "nope", duplicateOf: "survivor" },
        ]),
      ).toThrow(/Learning not found/);

      const [loser] = db.learnings.getLearningsByIds(["loser"]);
      expect(loser?.archivedAt).toBeNull();
      expect(loser?.duplicateOf).toBeNull();
      expect(ftsIds(db, "ubuntu").sort()).toEqual(["loser", "survivor"]);
    } finally {
      db.close();
    }
  });
});
