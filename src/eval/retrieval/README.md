# Retrieval bench (m0-2)

Deterministic benchmark for the learnings retrieval pipeline: given a task's
blind planner queries, does retrieval surface the learnings a dual-labeler
consensus says should surface? Two pipelines are scored side by side over the
same corpus, cases, and scope, so the delta between them is attributable to the
fusion and nothing else:

- **fts** — `searchLearnings`: bm25 over `learning_fts`.
- **hybrid** — `searchLearningsHybrid`: bm25 + brute-force cosine over the
  learning embeddings, fused with reciprocal rank fusion (k=60).

Scoring is exact match against the consensus labels — no live judge in the loop,
unlike the prompt evals.

## Committed numbers (2026-07-09, fixture-pinned, `bge-small-en-v1.5`)

```
pipeline  cases    r@5   r@10    mrr  zeroRecall   (26 labeled of 54 cases;
fts          26  0.474  0.474  0.546          11    28 are zero-expected
hybrid       26  0.663  0.737  0.708           3    distractors)
```

Hybrid beats the FTS baseline on every metric: +0.189 recall@5, +0.263 recall@10,
+0.162 MRR, and 8 of the 11 zero-recall cases now retrieve something relevant. No
labeled case regressed on recall or MRR.

`recallAt10 > recallAt5` for hybrid because cosine ranks the whole in-scope
corpus, landing relevant learnings at ranks 6–10 rather than nowhere. Under FTS
the two were identical: exact-token matching hits immediately or never.

The **fts** row is the historical baseline (committed 2026-07-08) and stays as
the control — it must keep reproducing exactly, or the hybrid delta is measuring
fixture drift rather than the fusion. Any further retrieval change (query
expansion, re-ranking, sqlite-vec) must beat these on the SAME fixtures. Do not
regenerate fixtures to make a number move.

## Fixtures — provenance

- `fixtures/corpus.json` — the 113 live automation-pilot learnings
  (snapshot 2026-07-07). Pinned; the bench DB is seeded from this, never from
  a live workspace.
- `fixtures/cases.json` — 54 cases, one per real executed task. Per case:
  - `queries`: written by an agent shown ONLY the ticket (blind to the corpus),
    simulating what a planner would type — not oracle queries.
  - `expected`: dual independent labelers over (task, full corpus); consensus =
    both picked it (high if either said high); single-high picks were human-
    reviewed (2026-07-08); single-low picks dropped.
  - `selfDerivedExcluded`: learnings created inside that task's own attempt
    window (first attempt start → last attempt finish) — a task's own output is
    not a valid retrieval expectation for itself. NOTE deliberately NOT a strict
    "must predate the task" rule: most of the corpus was born from these same
    54 tasks, so strict-predate leaves a 2-pair bench. Cross-task matches that
    happen to be later in time are legitimate capability tests.
  - `repos`: search scope replayed as production does: `shared` + task repos.

Labeling working files (raw dual labels, consensus merge script, disagreement
log) live outside the repo in the planning zone:
`~/invenco/tasks/foreman-learning-system/bench/`.

## Running

```bash
foreman eval retrieval          # both pipelines' metrics + per-case table
foreman eval retrieval --json   # { model, fts, hybrid } metrics as JSON
```

No workspace and no live runner, but the hybrid half needs the real embedding
model: the first run downloads ~133MB into `.cache/fastembed`, and every run
after that is offline. Inference is deterministic per model version, so the
committed numbers reproduce.

The harness (`run.ts` + `score.ts`) is the reference implementation: in-memory
SQLite, real migrations (0004 + 0005 + 0027), the real `SqliteLearningRepo`, and
the production embedding backfill — so the bench embeds exactly the text
production embeds and exercises `toSafeFtsQuery`'s exact-token quoting, the
brittleness the fusion exists to cover.

Guard tests:

- `__tests__/retrieval-bench.test.ts` — runs on every `pnpm test`, offline with a
  fake embedder. Pins the **fts** numbers exactly and asserts the hybrid metrics
  are structurally complete. The fake embedder's vectors are meaningless, so its
  hybrid *numbers* are not pinned here.
- `__tests__/retrieval-bench-hybrid.test.ts` — pins the **hybrid** numbers with
  the real model. Skipped by default so `pnpm test` never downloads a model; run
  it whenever ranking, fusion, or the embedded text changes:

  ```bash
  FOREMAN_BENCH_REAL_EMBEDDER=1 pnpm test retrieval-bench-hybrid
  ```

- `__tests__/score.test.ts` — the scorer's rank edge cases.

## Metrics

- recall@k: |expected ∩ top-k| / |expected|, averaged over labeled cases.
- MRR: 1/rank of the first expected hit (0 if none in top 10).
- Distractor cases (zero expected) are reserved for a future precision /
  false-positive metric once injection (M4) makes precision matter.
