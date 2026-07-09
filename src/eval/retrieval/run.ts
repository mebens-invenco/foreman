import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { backfillLearningEmbeddings } from "../../embeddings/backfill-learning-embeddings.js";
import type { Embedder } from "../../embeddings/embedder.js";
import { SqliteLearningRepo } from "../../repos/impl/sqlite-learning-repo.js";
import { aggregateMetrics, scoreCase, type BenchMetrics, type CaseScore } from "./score.js";

// The bench schema is pinned to the migrations that define the learning table,
// its FTS index, and the embedding table. Later migrations don't touch retrieval
// ranking; pinning keeps the committed baseline reproducible even if one would.
const BENCH_MIGRATIONS = ["0004_memory_tables.sql", "0005_learning_fts.sql", "0027_learning_embedding.sql"] as const;

// Fixtures and migrations are read from the on-disk checkout, resolved against
// the project root the same way the migration runner resolves it. They are NOT
// bundled into `dist` (tsc copies neither .json nor .sql), so this works from
// both `dist/cli.js` and vitest as long as the source tree is present.
const FIXTURES_DIR = path.join("src", "eval", "retrieval", "fixtures");

// Both pipelines are scored on the same top-10 window the metrics are defined over.
const RANK_DEPTH = 10;

interface CorpusLearning {
  id: string;
  title: string;
  repo: string;
  // Committed as a pre-serialized JSON string; tolerate an array too.
  tags: string | string[];
  confidence: string;
  content: string;
  applied_count?: number;
  read_count?: number;
  created_at: string;
  updated_at: string;
}

interface ExpectedLabel {
  id: string;
  confidence?: string;
}

interface RetrievalCase {
  taskId: string;
  queries: string[];
  repos?: string[];
  expected: ExpectedLabel[];
  selfDerivedExcluded?: string[];
}

export interface PerCaseResult {
  taskId: string;
  expected: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
}

export interface PipelineResult {
  metrics: BenchMetrics;
  perCase: PerCaseResult[];
}

export interface RetrievalBenchResult {
  /** The embedding model behind the `hybrid` numbers; vectors are only comparable within one. */
  model: string;
  fts: PipelineResult;
  hybrid: PipelineResult;
}

const readJson = <T>(filePath: string): T => JSON.parse(readFileSync(filePath, "utf8")) as T;

// Seed an in-memory DB: apply the pinned migrations (the FTS triggers backfill
// `learning_fts` on each insert), then load the corpus verbatim. The tags column
// is stored as-is when already a JSON string, matching how production persists it.
const seedDatabase = (projectRoot: string, corpus: readonly CorpusLearning[]): Database.Database => {
  const db = new Database(":memory:");
  for (const migration of BENCH_MIGRATIONS) {
    db.exec(readFileSync(path.join(projectRoot, "migrations", migration), "utf8"));
  }
  const insert = db.prepare(
    "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of corpus) {
    const tags = typeof row.tags === "string" ? row.tags : JSON.stringify(row.tags ?? []);
    insert.run(row.id, row.title, row.repo, tags, row.confidence, row.content, row.applied_count ?? 0, row.read_count ?? 0, row.created_at, row.updated_at);
  }
  return db;
};

// Replay production search scope: shared learnings plus the task's repos.
const scopeOf = (benchCase: RetrievalCase): string[] => ["shared", ...(benchCase.repos ?? [])];

const scorePipeline = (
  labeled: readonly RetrievalCase[],
  rank: (benchCase: RetrievalCase, index: number) => string[],
): PipelineResult => {
  const perCase: PerCaseResult[] = [];
  const scores: CaseScore[] = labeled.map((benchCase, index) => {
    const expectedIds = benchCase.expected.map((label) => label.id);
    const score = scoreCase(rank(benchCase, index), expectedIds);
    perCase.push({
      taskId: benchCase.taskId,
      expected: new Set(expectedIds).size,
      recallAt5: Number(score.recallAt5.toFixed(2)),
      recallAt10: Number(score.recallAt10.toFixed(2)),
      mrr: Number(score.mrr.toFixed(2)),
    });
    return score;
  });

  return { metrics: aggregateMetrics(scores), perCase };
};

/**
 * Run the retrieval bench over the committed fixtures, scoring the FTS-only and
 * hybrid (bm25 + cosine, RRF-fused) pipelines side by side on the SAME corpus,
 * cases, and scope — so the delta between them is attributable to the fusion and
 * nothing else.
 *
 * Deterministic given a fixed `embedder`: the corpus is seeded into an in-memory
 * SQLite DB, embedded through the production backfill (so the bench embeds
 * exactly the text production embeds), and each labeled case's blind planner
 * queries are replayed through the real `SqliteLearningRepo`.
 *
 * Only labeled cases (>= 1 expected) are scored; zero-expected distractor cases
 * are reserved for a future precision metric (see README).
 */
export const runRetrievalBench = async ({
  projectRoot,
  embedder,
}: {
  projectRoot: string;
  embedder: Embedder;
}): Promise<RetrievalBenchResult> => {
  const corpus = readJson<CorpusLearning[]>(path.join(projectRoot, FIXTURES_DIR, "corpus.json"));
  const cases = readJson<RetrievalCase[]>(path.join(projectRoot, FIXTURES_DIR, "cases.json"));

  const db = seedDatabase(projectRoot, corpus);
  try {
    const repo = new SqliteLearningRepo(db);
    await backfillLearningEmbeddings({ learnings: repo, embedder });

    const labeled = cases.filter((benchCase) => benchCase.expected.length > 0);

    // Every bench query in one embed call: inference dominates the runtime, and
    // batching it keeps a real-model run to a couple of seconds. `embed` is
    // order-preserving and length-checked, so slicing back per case is safe.
    const flatVectors = await embedder.embed(labeled.flatMap((benchCase) => benchCase.queries));
    const vectorsByCase: Float32Array[][] = [];
    let cursor = 0;
    for (const benchCase of labeled) {
      vectorsByCase.push(flatVectors.slice(cursor, cursor + benchCase.queries.length));
      cursor += benchCase.queries.length;
    }

    const fts = scorePipeline(labeled, (benchCase) =>
      repo.searchLearnings({ queries: benchCase.queries, repos: scopeOf(benchCase), limit: RANK_DEPTH }).map((record) => record.id),
    );
    const hybrid = scorePipeline(labeled, (benchCase, index) =>
      repo
        .searchLearningsHybrid(
          { queries: benchCase.queries, repos: scopeOf(benchCase), limit: RANK_DEPTH },
          { model: embedder.modelId, vectors: vectorsByCase[index]! },
        )
        .map((record) => record.id),
    );

    return { model: embedder.modelId, fts, hybrid };
  } finally {
    db.close();
  }
};

const formatMetricsRow = (label: string, metrics: BenchMetrics): string =>
  `${label.padEnd(8)} ${String(metrics.labeledCases).padStart(5)} ${metrics.recallAt5.toFixed(3).padStart(6)} ${metrics.recallAt10.toFixed(3).padStart(6)} ${metrics.mrr.toFixed(3).padStart(6)} ${String(metrics.zeroRecallCases).padStart(10)}`;

/** Human-readable default output: both pipelines' metrics, then a per-case table. */
export const formatRetrievalReport = (result: RetrievalBenchResult): string => {
  const { model, fts, hybrid } = result;
  const lines: string[] = [
    `Retrieval bench (offline, fixture-pinned) — embedding model: ${model}`,
    "",
    `${"pipeline".padEnd(8)} ${"cases".padStart(5)} ${"r@5".padStart(6)} ${"r@10".padStart(6)} ${"mrr".padStart(6)} ${"zeroRecall".padStart(10)}`,
    formatMetricsRow("fts", fts.metrics),
    formatMetricsRow("hybrid", hybrid.metrics),
    "",
    `${"taskId".padEnd(12)} ${"exp".padStart(3)} ${"fts r@5".padStart(8)} ${"hyb r@5".padStart(8)} ${"fts mrr".padStart(8)} ${"hyb mrr".padStart(8)}`,
  ];

  hybrid.perCase.forEach((hybridRow, index) => {
    const ftsRow = fts.perCase[index]!;
    lines.push(
      `${hybridRow.taskId.padEnd(12)} ${String(hybridRow.expected).padStart(3)} ${ftsRow.recallAt5.toFixed(2).padStart(8)} ${hybridRow.recallAt5.toFixed(2).padStart(8)} ${ftsRow.mrr.toFixed(2).padStart(8)} ${hybridRow.mrr.toFixed(2).padStart(8)}`,
    );
  });

  return lines.join("\n");
};
