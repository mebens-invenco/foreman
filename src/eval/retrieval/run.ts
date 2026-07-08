import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { SqliteLearningRepo } from "../../repos/impl/sqlite-learning-repo.js";
import { aggregateMetrics, scoreCase, type BenchMetrics } from "./score.js";

// The bench schema is pinned to the two migrations that define the learning
// table + FTS index. Later migrations don't touch retrieval ranking; pinning
// keeps the committed baseline reproducible even if a future migration would.
const BENCH_MIGRATIONS = ["0004_memory_tables.sql", "0005_learning_fts.sql"] as const;

// Fixtures and migrations are read from the on-disk checkout, resolved against
// the project root the same way the migration runner resolves it. They are NOT
// bundled into `dist` (tsc copies neither .json nor .sql), so this works from
// both `dist/cli.js` and vitest as long as the source tree is present.
const FIXTURES_DIR = path.join("src", "eval", "retrieval", "fixtures");

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

export interface RetrievalBenchResult {
  metrics: BenchMetrics;
  perCase: PerCaseResult[];
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

/**
 * Run the retrieval bench over the committed fixtures. Deterministic and
 * model-free: seeds the corpus into an in-memory SQLite DB, replays each labeled
 * case's blind planner queries through the real `SqliteLearningRepo`, and scores
 * recall@5/recall@10/MRR against the consensus `expected` labels.
 *
 * Only labeled cases (>= 1 expected) are scored; zero-expected distractor cases
 * are reserved for a future precision metric (see README).
 */
export const runRetrievalBench = ({ projectRoot }: { projectRoot: string }): RetrievalBenchResult => {
  const corpus = readJson<CorpusLearning[]>(path.join(projectRoot, FIXTURES_DIR, "corpus.json"));
  const cases = readJson<RetrievalCase[]>(path.join(projectRoot, FIXTURES_DIR, "cases.json"));

  const db = seedDatabase(projectRoot, corpus);
  try {
    const repo = new SqliteLearningRepo(db);
    const labeled = cases.filter((benchCase) => benchCase.expected.length > 0);

    const perCase: PerCaseResult[] = [];
    const scores = labeled.map((benchCase) => {
      // Replay production search scope: shared learnings plus the task's repos.
      const repos = ["shared", ...(benchCase.repos ?? [])];
      const rankedIds = repo.searchLearnings({ queries: benchCase.queries, repos, limit: 10 }).map((record) => record.id);
      const expectedIds = benchCase.expected.map((label) => label.id);
      const score = scoreCase(rankedIds, expectedIds);
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
  } finally {
    db.close();
  }
};

/** Human-readable default output: the metrics line plus a per-case table. */
export const formatRetrievalReport = (result: RetrievalBenchResult): string => {
  const { metrics, perCase } = result;
  const lines: string[] = [
    "Retrieval bench — FTS baseline (offline, fixture-pinned)",
    `labeledCases=${metrics.labeledCases}  recall@5=${metrics.recallAt5}  recall@10=${metrics.recallAt10}  MRR=${metrics.mrr}  zeroRecallCases=${metrics.zeroRecallCases}`,
    "",
    `${"taskId".padEnd(12)} ${"exp".padStart(3)} ${"r@5".padStart(5)} ${"r@10".padStart(5)} ${"mrr".padStart(5)}`,
  ];
  for (const row of perCase) {
    lines.push(
      `${row.taskId.padEnd(12)} ${String(row.expected).padStart(3)} ${row.recallAt5.toFixed(2).padStart(5)} ${row.recallAt10.toFixed(2).padStart(5)} ${row.mrr.toFixed(2).padStart(5)}`,
    );
  }
  return lines.join("\n");
};
