import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { backfillLearningEmbeddings } from "../backfill-learning-embeddings.js";
import { learningEmbeddingText } from "../learning-embedding-text.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createDb = async () => {
  const tempDir = await createTempDir("foreman-backfill-test-");
  cleanupDirs.push(tempDir);
  return createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
};

describe("backfillLearningEmbeddings", () => {
  test("embeds every learning on a cold corpus and does zero work on the second run", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();

    try {
      for (const id of ["learn-a", "learn-b"]) {
        db.learnings.addLearning({ id, title: `Title ${id}`, repo: "foreman", confidence: "emerging", content: `Body ${id}`, tags: [] });
      }

      const first = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });
      expect(first).toEqual({ model: embedder.modelId, total: 2, embedded: 2, skipped: 0 });
      expect(db.learnings.getLearningEmbeddings()).toHaveLength(2);
      expect(embedder.embeddedTexts).toEqual(["Title learn-a\nBody learn-a", "Title learn-b\nBody learn-b"]);

      const second = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });
      expect(second).toEqual({ model: embedder.modelId, total: 2, embedded: 0, skipped: 2 });
      // The idempotency claim is about work done, not just the reported counters.
      expect(embedder.calls).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("re-embeds only the learnings whose vector is missing", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();

    try {
      for (const id of ["learn-a", "learn-b"]) {
        db.learnings.addLearning({ id, title: id, repo: "foreman", confidence: "emerging", content: "body", tags: [] });
      }
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-a",
        model: embedder.modelId,
        dims: embedder.dims,
        vector: Float32Array.from([0, 0, 0]),
      });

      const result = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      expect(result).toEqual({ model: embedder.modelId, total: 2, embedded: 1, skipped: 1 });
      expect(embedder.embeddedTexts).toEqual([learningEmbeddingText({ title: "learn-b", content: "body" })]);
      // The pre-existing vector is left untouched.
      const stored = db.learnings.getLearningEmbeddings({ repos: ["foreman"] });
      expect(Array.from(stored.find((row) => row.learningId === "learn-a")!.vector)).toEqual([0, 0, 0]);
    } finally {
      db.close();
    }
  });

  test("re-embeds learnings carrying a vector from a different model", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder("new-model");

    try {
      db.learnings.addLearning({ id: "learn-a", title: "t", repo: "foreman", confidence: "emerging", content: "c", tags: [] });
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-a",
        model: "retired-model",
        dims: 3,
        vector: Float32Array.from([1, 1, 1]),
      });

      const result = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      expect(result).toEqual({ model: "new-model", total: 1, embedded: 1, skipped: 0 });
      expect(db.learnings.getLearningEmbeddings()[0]!.model).toBe("new-model");
    } finally {
      db.close();
    }
  });

  test("reports an empty corpus without calling the embedder", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();

    try {
      expect(await backfillLearningEmbeddings({ learnings: db.learnings, embedder })).toEqual({
        model: embedder.modelId,
        total: 0,
        embedded: 0,
        skipped: 0,
      });
      expect(embedder.calls).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
