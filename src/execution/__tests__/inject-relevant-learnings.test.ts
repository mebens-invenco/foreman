import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import type { Task } from "../../domain/index.js";
import { ForemanError } from "../../lib/errors.js";
import type { LearningInjectionAction, LearningInjectionEventRepo } from "../../repos/learning-injection-event-repo.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import {
  injectRelevantLearnings,
  INJECTION_SIMILARITY_FLOOR,
  RELEVANT_LEARNINGS_LIMIT,
  RELEVANT_LEARNINGS_TOKEN_BUDGET,
} from "../inject-relevant-learnings.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

const task = (input: { title: string; description: string }): Task => ({
  id: "ENG-1",
  provider: "linear",
  providerId: "ENG-1",
  title: input.title,
  description: input.description,
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-07-13T00:00:00Z",
  url: null,
});

const taskQuery = "vector retrieval tuning\nRank the learnings.";
const queryTask = task({ title: "vector retrieval tuning", description: "Rank the learnings." });

/** FakeEmbedder is 3-dim, so every seeded vector must be too. */
const seedLearning = (db: Db, input: { id: string; repo?: string; content: string; vector?: number[] }): void => {
  const content = input.content;
  db.learnings.addLearning({
    id: input.id,
    title: input.id,
    repo: input.repo ?? "shared",
    confidence: "established",
    content,
    tags: [],
  });
  if (input.vector) {
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

const ruleFor = (id: string): string => `**Rule:** Do the ${id} thing.`;
const contentWithRule = (id: string): string => `**Rule:** Do the ${id} thing.\n**When to apply:** Whenever.`;

/**
 * A unit vector sitting exactly `similarity` from the query, so a learning can be
 * seeded at a chosen cosine distance from the task rather than at whatever one
 * falls out of a hand-written triple.
 */
const vectorAtSimilarity = (similarity: number): number[] => [Math.sqrt(1 - similarity ** 2), similarity, 0];

/**
/**
 * Padding an unrelated query cannot reach by bm25 and the cosine arm scores 0.
 *
 * The corpus has to be mostly noise for a learning to be RANKED at all: the arm
 * proposes only what clears `COSINE_Z_FLOOR` = 2, and with `n` embeddings the
 * largest attainable z is `(n - 1) / sqrt(n)`, so a perfect match needs n >= 6
 * (1.79 at n = 5, 2.04 at n = 6). Injection does not gate on z — it floors on
 * similarity — so this bound only decides what reaches the seam, never what the
 * seam then injects. Seedings below carry headroom over it rather than sitting on it.
 */
const seedPadding = (db: Db, count: number, vector = [1, 0, 0]): void => {
  for (let index = 0; index < count; index += 1) {
    seedLearning(db, { id: `pad-${index}`, content: `filler ${index} unrelated`, vector });
  }
};

const withDb = async (run: (db: Db) => Promise<void>): Promise<void> => {
  const tempDir = await createTempDir("foreman-inject-learnings-test-");
  cleanupDirs.push(tempDir);
  const db = await createMigratedDb(path.join(tempDir, "foreman.db"), testProjectRoot);
  try {
    await run(db);
  } finally {
    db.close();
  }
};

/** Pins the task query to the vector that makes `learn-target` a cosine outlier. */
const embedderMatching = (targetVector = [0, 1, 0]): FakeEmbedder => {
  const embedder = new FakeEmbedder();
  embedder.vectorsByText.set(taskQuery, Float32Array.from(targetVector));
  return embedder;
};

const attemptId = "01ATTEMPT0000000000000000";

const injectWith = async (
  db: Db,
  embedder: FakeEmbedder,
  input: { task?: Task; repoKey?: string; action?: LearningInjectionAction; events?: LearningInjectionEventRepo } = {},
): Promise<{ digest: string | null; warnings: string[] }> => {
  const warnings: string[] = [];
  const digest = await injectRelevantLearnings(
    {
      learnings: db.learnings,
      embedder,
      warn: (message) => warnings.push(message),
      telemetry: { events: input.events ?? db.learningInjectionEvents, attemptId },
    },
    { task: input.task ?? queryTask, repoKey: input.repoKey ?? "foreman", action: input.action ?? "execution" },
  );
  return { digest, warnings };
};

/** The injection rows this attempt wrote, in the rank order the digest carried. */
const injectionRows = (db: Db): { learningId: string; rank: number; cosineSimilarity: number; appliedAt: string | null }[] =>
  db.database.sqlite
    .prepare("SELECT learning_id, rank, cosine_similarity, applied_at FROM learning_injection_event WHERE attempt_id = ? ORDER BY rank ASC")
    .all(attemptId)
    .map((row) => {
      const mapped = row as Record<string, unknown>;
      return {
        learningId: String(mapped.learning_id),
        rank: Number(mapped.rank),
        cosineSimilarity: Number(mapped.cosine_similarity),
        appliedAt: (mapped.applied_at as string | null) ?? null,
      };
    });

const entryIds = (digest: string): string[] =>
  digest
    .split("\n")
    .flatMap((line) => line.match(/^- `([^`]+)`/)?.[1] ?? []);

const estimateTokens = (text: string): number => Math.ceil(text.length * 0.25);

const readCountOf = (db: Db, id: string): number => db.learnings.listLearnings({ search: id }).find((row) => row.id === id)!.readCount;

describe("injectRelevantLearnings", () => {
  describe("when the cosine arm proposes a learning", () => {
    test("renders it as an id + title + Rule line entry", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 12);

        const { digest, warnings } = await injectWith(db, embedderMatching());

        expect(digest).not.toBeNull();
        expect(entryIds(digest!)).toEqual(["learn-target"]);
        expect(digest).toContain("## Relevant Learnings");
        expect(digest).toContain(ruleFor("learn-target"));
        expect(warnings).toEqual([]);
      });
    });

    test("embeds the task title and description as one query", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 12);
        const embedder = embedderMatching();

        await injectWith(db, embedder);

        expect(embedder.calls).toEqual([[taskQuery]]);
      });
    });

    test("falls back to the title alone when the content carries no Rule line", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: "Prose with no rule.", vector: [0, 1, 0] });
        seedPadding(db, 12);

        const { digest } = await injectWith(db, embedderMatching());

        expect(entryIds(digest!)).toEqual(["learn-target"]);
        expect(digest).not.toContain("**Rule:**");
      });
    });

    test("searches the task's repo and shared, and injects a repo-scoped learning", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", repo: "foreman", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 12);
        seedLearning(db, { id: "other-repo", repo: "shipping", content: contentWithRule("other-repo"), vector: [0, 1, 0] });

        const { digest } = await injectWith(db, embedderMatching());

        expect(entryIds(digest!)).toEqual(["learn-target"]);
      });
    });
  });

  describe("relevance floor", () => {
    test("keeps a learning above the similarity floor and drops one below it", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "close", content: contentWithRule("close"), vector: vectorAtSimilarity(0.8) });
        seedLearning(db, { id: "distant", content: contentWithRule("distant"), vector: vectorAtSimilarity(0.5) });
        // Enough noise that even `distant` clears the arm's own z bar (z = 2.8):
        // both must be RANKED, or the floor is not what is separating them.
        seedPadding(db, 30);

        const embedder = embedderMatching();
        const [queryVector] = await embedder.embed([taskQuery]);
        const covered = db.learnings.searchLearningsHybridCovered(
          { queries: [taskQuery], repos: ["foreman", "shared"], limit: RELEVANT_LEARNINGS_LIMIT },
          { model: embedder.modelId, vectors: [queryVector!] },
          { minCoverage: 0.9 },
        );
        if (!covered.covered) {
          throw new Error("expected a covered hybrid ranking");
        }

        // Both stand out from the corpus enough for the arm to RANK them — the
        // floor is the only thing separating them, and it separates on similarity.
        expect(covered.learnings.map((row) => row.id).sort()).toEqual(["close", "distant"]);
        expect(covered.provenance.get("close")!.bestCosineSimilarity).toBeCloseTo(0.8, 5);
        expect(covered.provenance.get("distant")!.bestCosineSimilarity).toBeCloseTo(0.5, 5);
        expect(INJECTION_SIMILARITY_FLOOR).toBeGreaterThan(0.5);
        expect(INJECTION_SIMILARITY_FLOOR).toBeLessThanOrEqual(0.8);

        const { digest } = await injectWith(db, embedder);
        expect(entryIds(digest!)).toEqual(["close"]);
      });
    });

    test("drops a hit the cosine arm never proposed, however well bm25 ranked it", async () => {
      await withDb(async (db) => {
        // Every vector identical: with no spread the cosine arm cannot name an
        // outlier and falls silent, so these reach the window on bm25 alone. A hit
        // with no similarity is not a hit known to be close, and is not pushed.
        for (let index = 0; index < 6; index += 1) {
          seedLearning(db, {
            id: `bm25-${index}`,
            content: `${contentWithRule(`bm25-${index}`)} vector retrieval tuning rank the learnings ${"filler ".repeat(index * 4)}`,
            vector: [1, 0, 0],
          });
        }

        const embedder = embedderMatching();
        const [queryVector] = await embedder.embed([taskQuery]);
        const covered = db.learnings.searchLearningsHybridCovered(
          { queries: [taskQuery], repos: ["foreman", "shared"], limit: RELEVANT_LEARNINGS_LIMIT },
          { model: embedder.modelId, vectors: [queryVector!] },
          { minCoverage: 0.9 },
        );
        if (!covered.covered) {
          throw new Error("expected a covered hybrid ranking");
        }

        expect(covered.learnings.length).toBe(RELEVANT_LEARNINGS_LIMIT);
        expect([...covered.provenance.values()].every((arms) => arms.bestCosineSimilarity === null)).toBe(true);

        const { digest, warnings } = await injectWith(db, embedder);
        expect(digest).toBeNull();
        expect(warnings).toEqual([]);
      });
    });

    test("injects nothing when the corpus holds nothing close to the task", async () => {
      await withDb(async (db) => {
        seedPadding(db, 13);

        const { digest, warnings } = await injectWith(db, embedderMatching());

        expect(digest).toBeNull();
        expect(warnings).toEqual([]);
      });
    });
  });

  // Ids run OPPOSITE to rank throughout: `zzz-hi` is the more similar learning and
  // `aaa-lo` the less. Seeded the other way round — or with equal vectors, where
  // RRF breaks the tie on id — rank order and id order coincide, and every
  // assertion below would hold just as well against a digest sorted alphabetically.
  describe("ordering", () => {
    const seedDivergent = (db: Db, rule = (id: string) => contentWithRule(id)): void => {
      seedLearning(db, { id: "zzz-hi", content: rule("zzz-hi"), vector: vectorAtSimilarity(0.85) });
      seedLearning(db, { id: "aaa-lo", content: rule("aaa-lo"), vector: vectorAtSimilarity(0.72) });
      seedPadding(db, 30);
    };

    test("renders entries in fused-rank order, not id order", async () => {
      await withDb(async (db) => {
        seedDivergent(db);

        const { digest } = await injectWith(db, embedderMatching());

        expect(entryIds(digest!)).toEqual(["zzz-hi", "aaa-lo"]);
      });
    });

    test("the token cap drops the lowest-ranked entry, not the last alphabetically", async () => {
      await withDb(async (db) => {
        // Sized so exactly one entry fits: the survivor names which end of the
        // ranking `fitToTokenBudget` trims from.
        const longRule = (id: string): string => `**Rule:** ${"x".repeat(1_400)} ${id}`;
        seedDivergent(db, longRule);

        const { digest } = await injectWith(db, embedderMatching());

        expect(entryIds(digest!)).toEqual(["zzz-hi"]);
        expect(estimateTokens(digest!)).toBeLessThanOrEqual(RELEVANT_LEARNINGS_TOKEN_BUDGET);
      });
    });
  });

  describe("caps", () => {
    test("drops the lowest-ranked entries until the section fits the token budget", async () => {
      await withDb(async (db) => {
        const longRule = "x".repeat(1_200);
        for (const id of ["cap-a", "cap-b", "cap-c"]) {
          seedLearning(db, { id, content: `**Rule:** ${longRule} ${id}`, vector: [0, 1, 0] });
        }
        seedPadding(db, 40);

        const { digest } = await injectWith(db, embedderMatching());

        // Cosine ranks the three identically, so the fusion breaks the tie on id:
        // the survivor is the head of the ranking, not an arbitrary one.
        expect(entryIds(digest!)).toEqual(["cap-a"]);
        expect(estimateTokens(digest!)).toBeLessThanOrEqual(RELEVANT_LEARNINGS_TOKEN_BUDGET);
      });
    });

    test("injects at most k entries", async () => {
      await withDb(async (db) => {
        for (let index = 0; index < RELEVANT_LEARNINGS_LIMIT + 3; index += 1) {
          seedLearning(db, { id: `many-${index}`, content: contentWithRule(`many-${index}`), vector: [0, 1, 0] });
        }
        seedPadding(db, 100);

        const { digest } = await injectWith(db, embedderMatching());

        expect(entryIds(digest!).length).toBeLessThanOrEqual(RELEVANT_LEARNINGS_LIMIT);
        expect(estimateTokens(digest!)).toBeLessThanOrEqual(RELEVANT_LEARNINGS_TOKEN_BUDGET);
      });
    });
  });

  describe("telemetry", () => {
    test("records one event per injected learning, ranked as the digest ranked them", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedLearning(db, { id: "learn-near", content: contentWithRule("learn-near"), vector: [0, 0.99, 0.1] });
        seedPadding(db, 12);

        const { digest } = await injectWith(db, embedderMatching());
        const rows = injectionRows(db);

        expect(rows.map((row) => row.learningId)).toEqual(entryIds(digest!));
        expect(rows.map((row) => row.rank)).toEqual(rows.map((_, index) => index + 1));
        for (const row of rows) {
          expect(row.cosineSimilarity).toBeGreaterThanOrEqual(INJECTION_SIMILARITY_FLOOR);
          expect(row.appliedAt).toBeNull();
        }
      });
    });

    test("records only the entries the token budget left in the prompt", async () => {
      await withDb(async (db) => {
        const longRule = "x".repeat(1_200);
        for (const id of ["cap-a", "cap-b", "cap-c"]) {
          seedLearning(db, { id, content: `**Rule:** ${longRule} ${id}`, vector: [0, 1, 0] });
        }
        seedPadding(db, 40);

        const { digest } = await injectWith(db, embedderMatching());

        // The two the budget dropped were retrieved but never handed to the agent.
        // Recording them would charge them against a hit-rate they could not earn.
        expect(entryIds(digest!)).toEqual(["cap-a"]);
        expect(injectionRows(db).map((row) => row.learningId)).toEqual(["cap-a"]);
      });
    });

    test("records nothing when nothing is injected", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 12);

        const { digest } = await injectWith(db, embedderMatching([1, 0, 0]));

        expect(digest).toBeNull();
        expect(injectionRows(db)).toEqual([]);
      });
    });

    test("stamps the action the digest was pushed into", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 12);

        await injectWith(db, embedderMatching(), { action: "review" });

        const actions = db.database.sqlite.prepare("SELECT action FROM learning_injection_event").all();
        expect(actions).toEqual([{ action: "review" }]);
      });
    });

    test("still injects the digest when recording it fails", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 12);
        const events: LearningInjectionEventRepo = {
          recordInjection: () => {
            throw new Error("disk is full");
          },
          markInjectedLearningApplied: () => 0,
          getInjectionStats: () => {
            throw new Error("unused");
          },
        };

        const { digest, warnings } = await injectWith(db, embedderMatching(), { events });

        // A prompt without its telemetry row is a prompt. A prompt without its
        // digest is a worse attempt, and the render must never trade one for the other.
        expect(entryIds(digest!)).toEqual(["learn-target"]);
        expect(warnings).toEqual(["relevant-learnings digest injected but not recorded: disk is full"]);
      });
    });
  });

  describe("injection is not a read", () => {
    test("leaves read_count untouched on every learning it retrieves and renders", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 12);

        const { digest } = await injectWith(db, embedderMatching());

        expect(entryIds(digest!)).toEqual(["learn-target"]);
        expect(readCountOf(db, "learn-target")).toBe(0);
        expect(readCountOf(db, "pad-0")).toBe(0);
      });
    });
  });

  describe("a degraded retrieval never fails the render", () => {
    test("injects nothing and warns exactly once, with the line that says what to do", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 8);
        seedLearning(db, { id: "bare-0", content: "unembedded filler" });
        seedLearning(db, { id: "bare-1", content: "unembedded filler two" });

        const { digest, warnings } = await injectWith(db, embedderMatching());

        // One line, from the layer that knows why. The seam adding its own would
        // double-warn a single degrade, and could only restate what it was told.
        expect(digest).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("backfill-embeddings");
      });
    });

    test("injects nothing when the embedder fails to infer", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 8);
        const embedder = embedderMatching();
        embedder.failure = new Error("model download failed");

        const { digest, warnings } = await injectWith(db, embedder);

        expect(digest).toBeNull();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("model download failed");
      });
    });

    test("swallows the embedder-contract defect that the CLI search path re-throws", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 8);
        const embedder = embedderMatching();
        embedder.failure = new ForemanError("embedding_dims_mismatch", "embedder returned 7 dims, expected 3", 500);

        const { digest, warnings } = await injectWith(db, embedder);

        expect(digest).toBeNull();
        expect(warnings.some((message) => message.includes("embedding_dims_mismatch") || message.includes("dims"))).toBe(true);
      });
    });

    test("injects nothing on an empty corpus, and says nothing about it", async () => {
      await withDb(async (db) => {
        const { digest, warnings } = await injectWith(db, embedderMatching());

        // An empty store is not a degrade. Warning here would put a line in the
        // log of every attempt in a workspace that has simply not learned anything.
        expect(digest).toBeNull();
        expect(warnings).toEqual([]);
      });
    });

    test("injects nothing when the task carries no text to embed", async () => {
      await withDb(async (db) => {
        seedLearning(db, { id: "learn-target", content: contentWithRule("learn-target"), vector: [0, 1, 0] });
        seedPadding(db, 8);
        const embedder = embedderMatching();

        const { digest } = await injectWith(db, embedder, { task: task({ title: "  ", description: "" }) });

        expect(digest).toBeNull();
        expect(embedder.calls).toEqual([]);
      });
    });
  });
});
