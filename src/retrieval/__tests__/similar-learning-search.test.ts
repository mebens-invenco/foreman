import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import type { Embedder } from "../../embeddings/embedder.js";
import { ForemanError } from "../../lib/errors.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { selectSimilarLearnings } from "../similar-learning-search.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

const withDb = async (run: (db: Db) => Promise<void>) => {
  const tempDir = await createTempDir("foreman-similar-search-test-");
  cleanupDirs.push(tempDir);
  const db = await createMigratedDb(path.join(tempDir, "foreman.db"), testProjectRoot);
  try {
    await run(db);
  } finally {
    db.close();
  }
};

const QUERY = "vector retrieval tuning";
const FLOOR = 0.7;

/** FakeEmbedder is 3-dim, so every seeded vector must be too. */
const seedLearning = (db: Db, input: { id: string; content?: string; vector?: number[] }): void => {
  const content = input.content ?? `**Rule:** Do the ${input.id} thing.`;
  db.learnings.addLearning({ id: input.id, title: input.id, repo: "shared", confidence: "established", content, tags: [] });
  if (input.vector) {
    // Guarded on the text the vector was computed from: pass what `addLearning` just
    // stored, or the seed silently no-ops and the corpus reads as unembedded.
    const applied = db.learnings.upsertLearningEmbedding({
      learningId: input.id,
      model: "fake-embedder-v1",
      dims: input.vector.length,
      vector: Float32Array.from(input.vector),
      embeddedTitle: input.id,
      embeddedContent: content,
    });
    expect(applied).toBe(true);
  }
};

/** The query embeds to [0, 1, 0], so this vector sits exactly `similarity` from it. */
const vectorAtSimilarity = (similarity: number): number[] => [Math.sqrt(1 - similarity ** 2), similarity, 0];

/** Orthogonal to the query: cosine scores it 0, so it can never clear the floor however much of it there is. */
const seedPadding = (db: Db, count: number, options: { embedded?: boolean; prefix?: string } = {}): void => {
  const embedded = options.embedded ?? true;
  const prefix = options.prefix ?? "pad";
  for (let index = 0; index < count; index += 1) {
    seedLearning(db, { id: `${prefix}-${index}`, ...(embedded ? { vector: [1, 0, 0] } : {}) });
  }
};

const embedderForQuery = (): FakeEmbedder => {
  const embedder = new FakeEmbedder();
  embedder.vectorsByText.set(QUERY, Float32Array.from([0, 1, 0]));
  return embedder;
};

const selectWith = async (
  db: Db,
  embedder: Embedder,
  overrides: { query?: string; limit?: number } = {},
): Promise<{ hits: { id: string; similarity: number }[]; warnings: string[] }> => {
  const warnings: string[] = [];
  const learnings = await selectSimilarLearnings(
    { learnings: db.learnings, embedder, warn: (message) => warnings.push(message) },
    { query: overrides.query ?? QUERY, repos: ["shared"], limit: overrides.limit ?? 5, minSimilarity: FLOOR },
  );

  return { hits: learnings.map((hit) => ({ id: hit.learning.id, similarity: hit.similarity })), warnings };
};

describe("selectSimilarLearnings", () => {
  describe("what it selects", () => {
    test("returns the learnings at or above the floor, closest first, each carrying its similarity", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedLearning(db, { id: "mid", vector: vectorAtSimilarity(0.75) });
        seedLearning(db, { id: "under", vector: vectorAtSimilarity(0.65) });
        seedPadding(db, 10);

        const { hits, warnings } = await selectWith(db, embedderForQuery());

        expect(hits.map((hit) => hit.id)).toEqual(["near", "mid"]);
        expect(hits[0]!.similarity).toBeCloseTo(0.9, 5);
        expect(hits[1]!.similarity).toBeCloseTo(0.75, 5);
        expect(warnings).toEqual([]);
      });
    });

    test("the limit is a cap, not a quota — a scope holding two admissible learnings yields two", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedLearning(db, { id: "mid", vector: vectorAtSimilarity(0.75) });
        seedPadding(db, 10);

        const { hits } = await selectWith(db, embedderForQuery(), { limit: 5 });

        expect(hits).toHaveLength(2);
      });
    });
  });

  describe("a degrade selects nothing rather than something worse", () => {
    test("warns and selects nothing when embedding coverage is short, without embedding the query", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedPadding(db, 5, { embedded: true });
        seedPadding(db, 4, { embedded: false, prefix: "unembedded" });
        const embedder = embedderForQuery();

        const { hits, warnings } = await selectWith(db, embedder);

        expect(hits).toEqual([]);
        expect(warnings).toEqual([
          "relevant-learnings injection skipped: only 6/10 in-scope learnings carry a fake-embedder-v1 vector " +
            "(need 90%); run `foreman learnings backfill-embeddings`",
        ]);
        // The gate short-circuits ahead of the model: on a cold cache that await is a
        // 133MB download that could not have changed the answer.
        expect(embedder.calls).toEqual([]);
      });
    });

    test("stays silent on an empty corpus — a workspace that has not learned anything yet is not a degrade", async () => {
      await withDb(async (db) => {
        const { hits, warnings } = await selectWith(db, embedderForQuery());

        expect(hits).toEqual([]);
        expect(warnings).toEqual([]);
      });
    });

    test("stays silent on an empty query, and never embeds it", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedPadding(db, 9);
        const embedder = embedderForQuery();

        const { hits, warnings } = await selectWith(db, embedder, { query: "   " });

        expect(hits).toEqual([]);
        expect(warnings).toEqual([]);
        expect(embedder.calls).toEqual([]);
      });
    });

    test("warns and selects nothing when the embedder fails to infer", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedPadding(db, 9);
        const embedder = embedderForQuery();
        embedder.failure = new Error("onnxruntime failed to load");

        const { hits, warnings } = await selectWith(db, embedder);

        expect(hits).toEqual([]);
        expect(warnings).toEqual(["relevant-learnings injection skipped: onnxruntime failed to load"]);
      });
    });

    test("propagates an embedder that breaks its own declared contract instead of degrading", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedPadding(db, 9);
        const embedder = embedderForQuery();
        embedder.failure = new ForemanError("embedding_dims_mismatch", "declared 3 dims, produced 7", 500);

        // A 500 is a defect in the adapter, not an outage. Degraded here it would hide
        // behind a warning indistinguishable from "nothing backfilled yet", forever.
        await expect(selectWith(db, embedder)).rejects.toMatchObject({ code: "embedding_dims_mismatch", statusCode: 500 });
      });
    });

    test("throws when the embedder returns no vector for the query", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedPadding(db, 9);

        // An embedder that resolves with fewer vectors than it was given texts has
        // broken its contract as surely as one that returns the wrong width.
        const vectorlessEmbedder: Embedder = { modelId: "fake-embedder-v1", dims: 3, embed: async () => [] };

        await expect(selectWith(db, vectorlessEmbedder)).rejects.toMatchObject({
          code: "embedding_query_vector_missing",
          statusCode: 500,
        });
      });
    });
  });

  /**
   * The corpus is free to move while the model initializes and infers — on a cold cache
   * that await is a 133MB download, and the serve loop writes learnings throughout. So the
   * gate the pre-check made is remade inside the snapshot that ranks, and these are the only
   * tests that make the two disagree. Both arms return an empty list, so the WARNING is what
   * distinguishes them: a real shortfall is actionable and says so; an emptied corpus is not.
   */
  describe("the coverage gate is re-made inside the snapshot that reads the vectors", () => {
    test("warns when coverage collapses while the query is in flight", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedPadding(db, 9);
        const embedder = embedderForQuery();

        // Fully covered when the gate is first consulted; every vector is stale by the
        // time the ranking runs, because the text each was computed from has moved.
        expect(db.learnings.countCurrentLearningEmbeddings({ repos: ["shared"], model: "fake-embedder-v1" })).toBe(10);
        embedder.onEmbed = () => {
          db.database.sqlite.prepare("UPDATE learning SET content = content || ' rewritten under the reader'").run();
        };

        const { hits, warnings } = await selectWith(db, embedder);

        expect(hits).toEqual([]);
        expect(warnings).toEqual([
          "relevant-learnings injection skipped: only 0/10 in-scope learnings carry a fake-embedder-v1 vector " +
            "(need 90%); run `foreman learnings backfill-embeddings`",
        ]);
      });
    });

    test("stays silent when the corpus empties while the query is in flight", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "near", vector: vectorAtSimilarity(0.9) });
        seedPadding(db, 9);
        const embedder = embedderForQuery();

        embedder.onEmbed = () => {
          db.database.sqlite.prepare("DELETE FROM learning_embedding").run();
          db.database.sqlite.prepare("DELETE FROM learning").run();
        };

        const { hits, warnings } = await selectWith(db, embedder);

        // `only 0/0 learnings carry a vector` is not a line anyone can act on, and the
        // pre-check's own empty-corpus arm is silent for the same reason.
        expect(hits).toEqual([]);
        expect(warnings).toEqual([]);
      });
    });
  });
});
