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

## Committed numbers (2026-07-09, fixture-pinned)

```
pipeline  cases    r@5   r@10    mrr  zeroRecall   (26 labeled of 54 cases;
fts          26  0.474  0.474  0.546          11    28 are zero-expected
null         26  0.474  0.474  0.462          11    distractors)
hybrid       26  0.676  0.696  0.721           3
```

- **fts** — the historical baseline (committed 2026-07-08), and the control. It
  must keep reproducing exactly, or the hybrid delta below is measuring fixture
  drift rather than the fusion.
- **null** — the *same* hybrid pipeline driven by `FakeEmbedder`, whose vectors
  are `[text.length, index, checksum(text)]` and carry no semantics at all. This
  is the **padding floor**: any recall it buys over `fts` was bought by filling
  the result window with arbitrary rows.
- **hybrid** — the real `bge-small-en-v1.5` model.

The null row buys **zero** recall over `fts`, so the whole of hybrid's
**+0.202 recall@5 / +0.222 recall@10 / +0.175 MRR** and its 11 → 3 zero-recall
drop is attributable to the model rather than to window padding. No labeled case
regressed on recall or MRR.

That is a property of the bounded cosine arm, and it is worth stating plainly
because an earlier revision of this pipeline did not have it. When the cosine arm
ranked the *entire* in-scope corpus, `null` scored `r@5 0.513 / r@10 0.561 /
zeroRecall 8` — a semantics-free embedder converting 3 of 11 zero-recall cases
purely by chance, with hybrid reading a flattering `0.663 / 0.737`. `recall@k`
cannot distinguish a lucky window from a good one, so the null row exists to.

`null` trails `fts` on MRR only because RRF merges multiple queries by best rank
while `searchLearnings` merges by best bm25 score; the retrieved sets are
identical, as `recallAt5` shows.

Any further retrieval change (query expansion, re-ranking, sqlite-vec) must beat
these on the SAME fixtures, and must keep `null` at the `fts` recall floor. Do
not regenerate fixtures to make a number move.

### Why the cosine arm is bounded, and not floored on similarity

`selectCosineCandidates` admits a learning only if its similarity is ≥ 2.0
standard deviations above the mean similarity of that query against the in-scope
corpus, capped at the 10 best. A **relative** bar, not an absolute one, because
bge-small's similarity scale is far too compressed for a fixed floor. Measured
over this corpus:

```
relevant pairs    p05 0.518   p50 0.590   p95 0.744
irrelevant pairs  p50 0.549   p95 0.621   p99 0.657
an unrelated query's nearest neighbour scores 0.637
```

Any absolute floor that rejects that nearest neighbour discards most genuinely
relevant pairs. The z-bar also falls silent on a corpus too sparse to *have* an
outlier: with `n` embeddings the largest attainable z is `(n - 1) / sqrt(n)`,
which stays under 2.0 until `n` reaches 6 — so a handful of freshly-embedded rows
cannot outrank the unembedded majority they are drowning in.

### …and why push injection floors on similarity anyway (M4, measured 2026-07-13)

The section above is about **ranking a query someone asked**. Push injection
(`src/execution/inject-relevant-learnings.ts`) asks a different question — *is this
close enough to shove at an agent who never asked?* — and the answer inverts twice.
Recorded here because these are point-in-time measurements; the code keeps only the
invariants they justify.

**1. bm25 falls silent on a long query, so "hybrid" here is nearly cosine alone.**
The `0.676` recall@5 above was earned on a planner's several *short* queries.
Injection issues **one long** query (a whole title + description), and
`toSafeFtsQuery` ANDs every term of it, so a learning must contain all of them to
match at all. Over the 54 bench cases bm25 matched in **1**, and 51 of 53
result-window entries came from the cosine arm alone. A recall number earned on
short queries does not transfer to a long-query path, and a floor built on bm25
rank there is dead code.

**2. z *inverts* on this path, so it cannot be the relevance floor.**
z is relative to one query's own distribution, and against a homogeneous corpus an
on-topic query is broadly similar to *everything* — so nothing stands out — while an
off-topic query gets a lucky outlier in a low, tight distribution. Against the live
corpus (143 learnings at the time), `"buy milk"` scored **z = 3.09** and a real
foreman ticket **z = 2.12**. A z floor would push learnings at the shopping list and
stay silent on the ticket. The plan's original lean — inject what the cosine arm
proposed (z ≥ 2.0) or what bm25 ranked top-3 — admitted **100%** of the window, and
would have injected into **23 of the 28** zero-expected distractor cases.

**3. Raw similarity does separate, on this query shape.**
Best hit per task, 19 real tickets vs 3 deliberately off-topic ones (CSS padding, a
k8s upgrade, buying milk):

```
                    committed corpus      live corpus (143 learnings)
real tasks          min 0.7163            0.743 - 0.863
off-topic tasks     max 0.6564            0.519 - 0.656
```

Hence `INJECTION_SIMILARITY_FLOOR = 0.70`. The live corpus measures wider — a bigger
corpus holds a closer match for every task — so production has more headroom than
the committed band; the committed numbers are the ones quoted in code because they
are the only ones a test can falsify. That test is
`src/execution/__tests__/injection-similarity-calibration.test.ts`, which pins the
band from both sides and is the only place the constant may be re-derived. This is
the precision use the distractor cases were reserved for (see Metrics, below).

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
  fake embedder. Pins the **fts** and **null** rows exactly. `FakeEmbedder` is a
  pure function of text and index, so the bench reproduces under it — which makes
  this a real tripwire for the fusion, the cross-query merge, and the pagination,
  none of which care what the vectors mean. It is what catches a merge or
  bounding regression that the unit tests alone would miss.
- `__tests__/retrieval-bench-hybrid.test.ts` — pins the **hybrid** row with the
  real model. This is the *accuracy* guard: whether the ranking is any good is
  the one thing a fake embedder cannot tell you. Skipped by default so `pnpm test`
  never downloads a model; run it whenever ranking, fusion, or the embedded text
  changes:

  ```bash
  FOREMAN_BENCH_REAL_EMBEDDER=1 pnpm test retrieval-bench-hybrid
  ```

- `__tests__/score.test.ts` — the scorer's rank edge cases.

## Metrics

- recall@k: |expected ∩ top-k| / |expected|, averaged over labeled cases.
- MRR: 1/rank of the first expected hit (0 if none in top 10).
- Distractor cases (zero expected) are reserved for a future precision /
  false-positive metric once injection (M4) makes precision matter.
