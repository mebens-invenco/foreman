import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { ForemanError } from "../../lib/errors.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { searchLearningsWithHybridFallback } from "../hybrid-learning-search.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// FakeEmbedder is 3-dim, so seeded vectors must be too — a width mismatch is a
// defect the repo raises, not a shape the fusion tolerates.
const seedLearning = (
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  input: { id: string; repo: string; content: string; vector?: number[]; model?: string },
) => {
  db.learnings.addLearning({
    id: input.id,
    title: input.id,
    repo: input.repo,
    confidence: "established",
    content: input.content,
    tags: [],
  });
  if (input.vector) {
    // Guarded on the text the vector was computed from: pass what `addLearning`
    // just stored, or the seed silently no-ops and the corpus reads as unembedded.
    const applied = db.learnings.upsertLearningEmbedding({
      learningId: input.id,
      model: input.model ?? "fake-embedder-v1",
      dims: input.vector.length,
      vector: Float32Array.from(input.vector),
      embeddedTitle: input.id,
      embeddedContent: input.content,
    });
    expect(applied).toBe(true);
  }
};

/** `target` is the only learning bm25 can reach; the rest pad the corpus. */
const seedCorpus = (
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  options: { embeddedPadding?: number; unembeddedPadding?: number; embedTarget?: boolean } = {},
) => {
  const { embeddedPadding = 8, unembeddedPadding = 0, embedTarget = true } = options;
  seedLearning(db, {
    id: "learn-target",
    repo: "shared",
    content: "planning prompt cli",
    ...(embedTarget ? { vector: [0, 1, 0] } : {}),
  });
  for (let index = 0; index < embeddedPadding; index += 1) {
    seedLearning(db, { id: `pad-${index}`, repo: "shared", content: `filler ${index} unrelated`, vector: [1, 0, 0] });
  }
  for (let index = 0; index < unembeddedPadding; index += 1) {
    seedLearning(db, { id: `bare-${index}`, repo: "shared", content: `bare ${index} unrelated` });
  }
};

const withDb = async (run: (db: Awaited<ReturnType<typeof createMigratedDb>>) => Promise<void>) => {
  const tempDir = await createTempDir("foreman-hybrid-search-test-");
  cleanupDirs.push(tempDir);
  const db = await createMigratedDb(path.join(tempDir, "foreman.db"), testProjectRoot);
  try {
    await run(db);
  } finally {
    db.close();
  }
};

describe("searchLearningsWithHybridFallback", () => {
  test("answers via hybrid and says so when the scope is fully embedded", async () => {
    await withDb(async (db) => {
      seedCorpus(db);
      const warnings: string[] = [];

      const result = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(result.pipeline).toBe("hybrid");
      expect(result.learnings.map((learning) => learning.id)).toContain("learn-target");
      expect(warnings).toEqual([]);
    });
  });

  test("degrades to FTS with a warning when the scope has no embeddings", async () => {
    await withDb(async (db) => {
      seedCorpus(db, { embeddedPadding: 0, embedTarget: false });
      const warnings: string[] = [];
      const embedder = new FakeEmbedder();

      const result = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder, warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      // Still a real search: the FTS pipeline answers, and nothing was embedded.
      expect(result.pipeline).toBe("fts");
      expect(result.learnings.map((learning) => learning.id)).toEqual(["learn-target"]);
      expect(embedder.embeddedTexts).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/falling back to FTS/);
      expect(warnings[0]).toMatch(/backfill-embeddings/);
    });
  });

  test("degrades on partial coverage, where an embedded row would outrank an unembedded one", async () => {
    await withDb(async (db) => {
      // 9 embedded of 19 — presence is not coverage. Under a presence check the
      // embedded rows collect fusion weight the unembedded majority can never
      // earn, and hybrid can rank below the FTS baseline this change is gated on.
      seedCorpus(db, { embeddedPadding: 8, unembeddedPadding: 10 });
      const warnings: string[] = [];

      const result = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(result.pipeline).toBe("fts");
      expect(result.learnings.map((learning) => learning.id)).toEqual(["learn-target"]);
      expect(warnings[0]).toMatch(/only 9\/19 in-scope learnings carry a fake-embedder-v1 vector/);
    });
  });

  test("degrades to FTS when the scope's only embeddings belong to another model", async () => {
    await withDb(async (db) => {
      // A stale generation must not be ranked against a new model's query vector.
      seedLearning(db, { id: "learn-target", repo: "shared", content: "planning prompt cli", vector: [1, 0, 0], model: "old-model" });
      const warnings: string[] = [];

      const result = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(result.pipeline).toBe("fts");
      expect(result.learnings.map((learning) => learning.id)).toEqual(["learn-target"]);
      expect(warnings).toHaveLength(1);
    });
  });

  test("degrades to FTS with a warning when the embedder fails", async () => {
    await withDb(async (db) => {
      seedCorpus(db);
      const embedder = new FakeEmbedder();
      embedder.failure = new Error("model download failed");
      const warnings: string[] = [];

      const result = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder, warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(result.pipeline).toBe("fts");
      expect(result.learnings.map((learning) => learning.id)).toEqual(["learn-target"]);
      expect(warnings[0]).toMatch(/model download failed/);
    });
  });

  test("propagates an embedder that breaks its own contract instead of degrading", async () => {
    await withDb(async (db) => {
      seedCorpus(db);
      const embedder = new FakeEmbedder();
      embedder.failure = new ForemanError("embedding_dims_mismatch", "declared 3 dims, produced 7", 500);

      // A 500 is a defect in the adapter. Swallowing it would hide the fault
      // behind a warning indistinguishable from "nothing backfilled yet", once
      // per search, forever.
      await expect(
        searchLearningsWithHybridFallback(
          { learnings: db.learnings, embedder, warn: () => {} },
          { queries: ["planning prompt"], repos: ["shared"] },
        ),
      ).rejects.toThrow(/declared 3 dims/);
    });
  });

  test("propagates a corrupt stored vector instead of degrading", async () => {
    await withDb(async (db) => {
      seedCorpus(db);
      // A vector of the wrong width under the right model name: a truncated blob
      // or schema drift. `searchLearnings` never reads `learning_embedding`, so a
      // silent fallback here would go unnoticed indefinitely.
      const corrupted = db.learnings.getLearningsByIds(["pad-0"])[0]!;
      const applied = db.learnings.upsertLearningEmbedding({
        learningId: corrupted.id,
        model: "fake-embedder-v1",
        dims: 2,
        vector: Float32Array.from([1, 0]),
        embeddedTitle: corrupted.title,
        embeddedContent: corrupted.content,
      });
      // Without this the guarded write could no-op and the test would assert
      // nothing about the corrupt vector it means to plant.
      expect(applied).toBe(true);

      await expect(
        searchLearningsWithHybridFallback(
          { learnings: db.learnings, embedder: new FakeEmbedder(), warn: () => {} },
          { queries: ["planning prompt"], repos: ["shared"] },
        ),
      ).rejects.toThrow(/3-dim vector with a 2-dim vector/);
    });
  });

  test("counts a read exactly once whichever pipeline answers", async () => {
    await withDb(async (db) => {
      seedCorpus(db);
      const embedder = new FakeEmbedder();
      embedder.failure = new Error("model download failed");

      await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder, warn: () => {} },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      // The hybrid attempt threw before it could increment, so the fallback's
      // increment is the only one — a double count would mean both pipelines ran.
      expect(db.learnings.getLearningsByIds(["learn-target"])[0]!.readCount).toBe(1);
    });
  });

  test("keeps an out-of-scope repo's embeddings from satisfying the coverage check", async () => {
    await withDb(async (db) => {
      seedLearning(db, { id: "learn-other", repo: "other-repo", content: "body", vector: [1, 0, 0] });
      seedLearning(db, { id: "learn-shared", repo: "shared", content: "planning prompt cli" });
      const warnings: string[] = [];

      const result = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(result.pipeline).toBe("fts");
      expect(result.learnings.map((learning) => learning.id)).toEqual(["learn-shared"]);
      expect(warnings).toHaveLength(1);
    });
  });

  test("reports FTS without a warning when the scope holds no learnings at all", async () => {
    await withDb(async (db) => {
      const warnings: string[] = [];

      const result = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      // An empty scope is not a degraded search; there is nothing to retrieve.
      expect(result).toEqual({ pipeline: "fts", learnings: [] });
      expect(warnings).toEqual([]);
    });
  });
});
