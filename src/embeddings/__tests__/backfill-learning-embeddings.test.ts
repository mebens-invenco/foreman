import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { FakeEmbedder, fakeEmbeddingVector } from "../../test-support/fake-embedder.js";
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

  test("re-embeds an edited learning once, then converges", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();

    try {
      db.learnings.addLearning({ id: "learn-a", title: "Title", repo: "foreman", confidence: "emerging", content: "Body", tags: [] });
      await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      // Metadata churn must not send the model any work: the embedded text is
      // untouched, and `worker-result-applier` would not re-embed for it either.
      db.learnings.updateLearning({ id: "learn-a", markApplied: true, tags: ["x"], confidence: "proven" });
      expect(await backfillLearningEmbeddings({ learnings: db.learnings, embedder })).toEqual({
        model: embedder.modelId,
        total: 1,
        embedded: 0,
        skipped: 1,
      });
      expect(embedder.calls).toHaveLength(1);

      // A text edit does, exactly once. The re-embed has to refresh the stored
      // text snapshot as well as the vector, or the row stays flagged and every
      // later backfill embeds it again, forever.
      db.learnings.updateLearning({ id: "learn-a", content: "Rewritten" });
      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toEqual(["learn-a"]);
      expect(await backfillLearningEmbeddings({ learnings: db.learnings, embedder })).toEqual({
        model: embedder.modelId,
        total: 1,
        embedded: 1,
        skipped: 0,
      });
      expect(embedder.embeddedTexts).toEqual(["Title\nBody", "Title\nRewritten"]);

      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toEqual([]);
      expect(await backfillLearningEmbeddings({ learnings: db.learnings, embedder })).toEqual({
        model: embedder.modelId,
        total: 1,
        embedded: 0,
        skipped: 1,
      });
      expect(embedder.calls).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("repairs a vector corrupted after it was written, so search is never bricked", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();

    try {
      for (const id of ["learn-a", "learn-b"]) {
        db.learnings.addLearning({ id, title: id, repo: "shared", confidence: "emerging", content: `body ${id}`, tags: [] });
      }
      await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      // The write boundary refuses an unrankable vector, so a rotted blob can only
      // arrive here — bit-rot, a partial write, someone's SQL. Its text snapshot
      // still matches, which is what used to make it invisible to the backfill and
      // fatal to every search: `learnings search` threw, and the warning telling
      // the operator to run this very command was a no-op.
      db.database.sqlite
        .prepare("UPDATE learning_embedding SET vector = ? WHERE learning_id = ?")
        .run(Buffer.from(Float32Array.from([0, 0, 0]).buffer), "learn-a");

      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toEqual(["learn-a"]);

      const repair = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      expect(repair).toEqual({ model: embedder.modelId, total: 2, embedded: 1, skipped: 1 });
      expect(embedder.embeddedTexts.at(-1)).toBe(learningEmbeddingText({ title: "learn-a", content: "body learn-a" }));
      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toEqual([]);
      expect(db.learnings.countCurrentLearningEmbeddings({ model: embedder.modelId })).toBe(2);

      // And it converges: the repaired row is not re-embedded forever after.
      expect(await backfillLearningEmbeddings({ learnings: db.learnings, embedder })).toEqual({
        model: embedder.modelId,
        total: 2,
        embedded: 0,
        skipped: 2,
      });
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
      // A sentinel standing for "this learning already has a vector" — distinct
      // from anything FakeEmbedder produces, so a re-embed would be visible.
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-a",
        model: embedder.modelId,
        dims: embedder.dims,
        vector: Float32Array.from([-9, -9, -9]),
        embeddedTitle: "learn-a",
        embeddedContent: "body",
      });

      const result = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      expect(result).toEqual({ model: embedder.modelId, total: 2, embedded: 1, skipped: 1 });
      expect(embedder.embeddedTexts).toEqual([learningEmbeddingText({ title: "learn-b", content: "body" })]);
      // The pre-existing vector is left untouched.
      const stored = db.learnings.getLearningEmbeddings({ repos: ["foreman"] });
      expect(Array.from(stored.find((row) => row.learningId === "learn-a")!.vector)).toEqual([-9, -9, -9]);
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
        embeddedTitle: "t",
        embeddedContent: "c",
      });

      const result = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      expect(result).toEqual({ model: "new-model", total: 1, embedded: 1, skipped: 0 });
      expect(db.learnings.getLearningEmbeddings()[0]!.model).toBe("new-model");
    } finally {
      db.close();
    }
  });

  test("carries every learning across the batch boundary", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();
    // One past BATCH_SIZE (32), so the slice loop runs twice. Zero-padded ids
    // keep `listLearningIdsMissingEmbedding`'s `ORDER BY id ASC` predictable.
    const ids = Array.from({ length: 33 }, (_, index) => `learn-${String(index).padStart(2, "0")}`);

    try {
      for (const id of ids) {
        db.learnings.addLearning({ id, title: id, repo: "foreman", confidence: "emerging", content: `body ${id}`, tags: [] });
      }

      const result = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      expect(result).toEqual({ model: embedder.modelId, total: 33, embedded: 33, skipped: 0 });
      expect(embedder.calls.map((call) => call.length)).toEqual([32, 1]);
      // Every seeded learning got a row — nothing dropped at the 32/33 seam.
      expect(db.learnings.getLearningEmbeddings().map((row) => row.learningId)).toEqual(ids);

      // The last id is index 0 of the *second* batch, so a stored vector whose
      // index component is 32 would mean the batches were flattened wrongly.
      const last = db.learnings.getLearningEmbeddings().at(-1)!;
      expect(Array.from(last.vector)).toEqual(
        Array.from(fakeEmbeddingVector(learningEmbeddingText({ title: "learn-32", content: "body learn-32" }), 0)),
      );

      const second = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });
      expect(second).toEqual({ model: embedder.modelId, total: 33, embedded: 0, skipped: 33 });
      expect(embedder.calls).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("drops its vector when the serve loop edits the learning mid-embed", async () => {
    const db = await createDb();
    const embedder = new FakeEmbedder();

    try {
      db.learnings.addLearning({ id: "learn-a", title: "T", repo: "foreman", confidence: "emerging", content: "A", tags: [] });

      // Backfill has already read text "A" and is embedding it. Meanwhile the
      // serve loop rewrites the learning to "B" and stores B's vector.
      embedder.onEmbed = () => {
        embedder.onEmbed = null;
        db.learnings.updateLearning({ id: "learn-a", content: "B" });
        const applied = db.learnings.upsertLearningEmbedding({
          learningId: "learn-a",
          model: embedder.modelId,
          dims: embedder.dims,
          vector: Float32Array.from([9, 9, 9]),
          embeddedTitle: "T",
          embeddedContent: "B",
        });
        expect(applied).toBe(true);
      };

      const result = await backfillLearningEmbeddings({ learnings: db.learnings, embedder });

      // Backfill's vector describes text "A", which no longer exists. Writing it
      // would stamp learning_embedding.updated_at newer than learning.updated_at
      // and hide the row from listLearningIdsMissingEmbedding forever.
      expect(result).toEqual({ model: embedder.modelId, total: 1, embedded: 0, skipped: 1 });
      expect(Array.from(db.learnings.getLearningEmbeddings()[0]!.vector)).toEqual([9, 9, 9]);
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
