# Retrieval bench (m0-2)

Deterministic benchmark for the learnings retrieval pipeline: given a task's
blind planner queries, does `searchLearnings` surface the learnings a dual-labeler
consensus says should surface? No live model in the loop — unlike the prompt
evals, this is exact-match scoring and cheap enough to run on every retrieval
change.

## Committed FTS baseline (2026-07-08, fixture-pinned)

```
labeledCases: 26   (of 54 cases; 28 are zero-expected distractors)
recallAt5:  0.474
recallAt10: 0.474   <- identical to @5: exact-token FTS hits immediately or never
mrr:        0.546
zeroRecallCases: 11 (42% of labeled cases retrieve nothing relevant in top 10)
```

Any retrieval change (hybrid embedding search, query expansion) must beat this
on the SAME fixtures. Do not regenerate fixtures to make a number move.

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

## Running the prototype

```bash
node src/eval/retrieval/baseline.mjs <dir-containing-fixtures>
```

`baseline.mjs` is the reference implementation: in-memory SQLite, real
migrations (0004 + 0005), real `SqliteLearningRepo`, replayed queries, so it
exercises `toSafeFtsQuery`'s exact-token quoting — the brittleness under test.

## Metrics

- recall@k: |expected ∩ top-k| / |expected|, averaged over labeled cases.
- MRR: 1/rank of the first expected hit (0 if none in top 10).
- Distractor cases (zero expected) are reserved for a future precision /
  false-positive metric once injection (M4) makes precision matter.
