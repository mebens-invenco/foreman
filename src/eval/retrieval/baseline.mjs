// m0-2 retrieval bench — FTS baseline runner (prototype; the ENG ticket formalizes this)
// Runs the real SqliteLearningRepo over an in-memory DB seeded from the corpus fixture,
// replays each case's blind planner queries, scores recall@k + MRR against consensus labels.
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SqliteLearningRepo } from "./dist/repos/impl/sqlite-learning-repo.js";

const BENCH_DIR = process.argv[2];
if (!BENCH_DIR) throw new Error("usage: node bench-baseline.mjs <bench-dir>");

const corpus = JSON.parse(readFileSync(path.join(BENCH_DIR, "corpus.json"), "utf8"));
const cases = JSON.parse(readFileSync(path.join(BENCH_DIR, "cases.json"), "utf8"));

const db = new Database(":memory:");
for (const m of ["0004_memory_tables.sql", "0005_learning_fts.sql"]) {
  db.exec(readFileSync(path.join(import.meta.dirname, "migrations", m), "utf8"));
}
const insert = db.prepare(
  "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
);
for (const l of corpus) {
  const tagsJson = typeof l.tags === "string" ? l.tags : JSON.stringify(l.tags ?? []);
  insert.run(l.id, l.title, l.repo, tagsJson, l.confidence, l.content,
    l.applied_count ?? 0, l.read_count ?? 0, l.created_at, l.updated_at);
}
const repo = new SqliteLearningRepo(db);

const K = [5, 10];
const labeled = cases.filter((c) => c.expected.length > 0);
let sums = { r5: 0, r10: 0, mrr: 0 };
const perCase = [];
for (const c of labeled) {
  const repos = ["shared", ...(c.repos ?? [])];
  const results = repo.searchLearnings({ queries: c.queries, repos, limit: 10 });
  const ranked = results.map((r) => r.id);
  const expected = new Set(c.expected.map((e) => e.id));
  const hitsAt = (k) => ranked.slice(0, k).filter((id) => expected.has(id)).length;
  const firstRank = ranked.findIndex((id) => expected.has(id));
  const r5 = hitsAt(5) / expected.size;
  const r10 = hitsAt(10) / expected.size;
  const mrr = firstRank === -1 ? 0 : 1 / (firstRank + 1);
  sums.r5 += r5; sums.r10 += r10; sums.mrr += mrr;
  perCase.push({ taskId: c.taskId, expected: expected.size, r5: +r5.toFixed(2), r10: +r10.toFixed(2), mrr: +mrr.toFixed(2) });
}
const n = labeled.length;
console.log(JSON.stringify({
  labeledCases: n,
  recallAt5: +(sums.r5 / n).toFixed(3),
  recallAt10: +(sums.r10 / n).toFixed(3),
  mrr: +(sums.mrr / n).toFixed(3),
  zeroRecallCases: perCase.filter((p) => p.r10 === 0).length,
}, null, 2));
console.log(perCase.map((p) => `${p.taskId} exp=${p.expected} r5=${p.r5} r10=${p.r10} mrr=${p.mrr}`).join("\n"));
