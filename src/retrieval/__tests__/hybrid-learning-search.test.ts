import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { searchLearningsWithHybridFallback } from "../hybrid-learning-search.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// FakeEmbedder is 3-dim, so the seeded vectors must be too — a width mismatch
// would throw inside the repo and quietly turn a "hybrid" test into a fallback one.
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
    db.learnings.upsertLearningEmbedding({
      learningId: input.id,
      model: input.model ?? "fake-embedder-v1",
      dims: 3,
      vector: Float32Array.from(input.vector),
    });
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

// The query shares no token with any seeded learning, so bm25 alone returns
// nothing: any hit at all proves the cosine half of the fusion ran.
const COSINE_ONLY_QUERY = "vendored manifest snapshot";

describe("searchLearningsWithHybridFallback", () => {
  test("retrieves by cosine when the scope has embeddings for the embedder's model", async () => {
    await withDb(async (db) => {
      seedLearning(db, { id: "learn-a", repo: "shared", content: "unrelated tokens entirely", vector: [1, 0, 0] });
      const warnings: string[] = [];

      const learnings = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: [COSINE_ONLY_QUERY], repos: ["shared"] },
      );

      expect(learnings.map((learning) => learning.id)).toEqual(["learn-a"]);
      expect(warnings).toEqual([]);
    });
  });

  test("degrades to FTS with a warning when the scope has no embeddings", async () => {
    await withDb(async (db) => {
      seedLearning(db, { id: "learn-a", repo: "shared", content: "planning prompt cli" });
      const warnings: string[] = [];
      const embedder = new FakeEmbedder();

      const learnings = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder, warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      // Still a real search: the FTS pipeline answers, and nothing was embedded.
      expect(learnings.map((learning) => learning.id)).toEqual(["learn-a"]);
      expect(embedder.embeddedTexts).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/falling back to FTS/);
      expect(warnings[0]).toMatch(/backfill-embeddings/);
    });
  });

  test("degrades to FTS when the scope's only embeddings belong to another model", async () => {
    await withDb(async (db) => {
      // A stale generation must not be ranked against a new model's query vector.
      seedLearning(db, { id: "learn-a", repo: "shared", content: "planning prompt cli", vector: [1, 0, 0], model: "old-model" });
      const warnings: string[] = [];

      const learnings = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(learnings.map((learning) => learning.id)).toEqual(["learn-a"]);
      expect(warnings).toHaveLength(1);
    });
  });

  test("degrades to FTS with a warning when the embedder fails", async () => {
    await withDb(async (db) => {
      seedLearning(db, { id: "learn-a", repo: "shared", content: "planning prompt cli", vector: [1, 0, 0] });
      const embedder = new FakeEmbedder();
      embedder.failure = new Error("model download failed");
      const warnings: string[] = [];

      const learnings = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder, warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(learnings.map((learning) => learning.id)).toEqual(["learn-a"]);
      expect(warnings[0]).toMatch(/model download failed/);
    });
  });

  test("counts a read exactly once whichever pipeline answers", async () => {
    await withDb(async (db) => {
      seedLearning(db, { id: "learn-a", repo: "shared", content: "planning prompt cli", vector: [1, 0, 0] });
      const embedder = new FakeEmbedder();
      embedder.failure = new Error("model download failed");

      await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder, warn: () => {} },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      // The hybrid attempt threw before it could increment, so the fallback's
      // increment is the only one — a double count would mean both pipelines ran.
      expect(db.learnings.getLearningsByIds(["learn-a"])[0]!.readCount).toBe(1);
    });
  });

  test("keeps an out-of-scope repo's embeddings from satisfying the scope check", async () => {
    await withDb(async (db) => {
      seedLearning(db, { id: "learn-other", repo: "other-repo", content: "body", vector: [1, 0, 0] });
      seedLearning(db, { id: "learn-shared", repo: "shared", content: "planning prompt cli" });
      const warnings: string[] = [];

      const learnings = await searchLearningsWithHybridFallback(
        { learnings: db.learnings, embedder: new FakeEmbedder(), warn: (message) => warnings.push(message) },
        { queries: ["planning prompt"], repos: ["shared"] },
      );

      expect(learnings.map((learning) => learning.id)).toEqual(["learn-shared"]);
      expect(warnings).toHaveLength(1);
    });
  });
});
