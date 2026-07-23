# Prompt evals

A behavioral evaluation pipeline for Foreman's worker prompts. Unlike the
structural prompt tests (`src/__tests__/prompts.test.ts`, which assert on
*rendered prompt text*), an eval runs a prompt **through a live model** and
grades the **model's output/behavior**.

## Concept

The durable artifact is the per-prompt **`EvalDefinition`** (`registry.ts`): a
set of **cases** plus the **graders** applied to each sample. The execution
mode (which runner, how many samples) is a knob, not a separate harness.

```
case ──► render real worker prompt + inject scenario ──► live runner (k samples)
     ──► parse + validate ──► graders ──► per-dimension pass/fail ──► pass-rate
```

Graders come in two kinds, both run on the **model output**:

- **deterministic, gating** — schema valid; the learning decision matches the
  case's expectation; ≥1 action tag including the surfacing action; required
  `**Rule:** / **When to apply:**` content structure. Cheap and exact; they cover
  what the loose worker-result Zod schema lets through.
- **advisory, non-gating** — reported but never fail a sample on their own:
  - `scope` — an emitted learning's `repo` matches the case's `expectScope`
    (`shared` only when the insight is clearly cross-repo).
  - `quality` (LLM-as-judge) — a binary yes/no on what structure can't see: is
    the learning a generalizable rule worth keeping, or a one-off? Advisory:
    calibrated, but not yet gating-ready — see **Judge calibration**.
    `--no-judge` disables it.

Non-determinism is handled by sampling each case `--samples` times and
reporting the **pass-rate** per dimension, not a single pass/fail.

## Running

Opt-in, not part of CI — it shells out to an authed agent CLI and costs tokens.

```bash
# default runner, 3 samples/case
node dist/cli.js eval learning-policy

# cheap smoke: one case, one sample, deterministic graders only
node dist/cli.js eval learning-policy --case reusable-insight --samples 1 --no-judge

# pick a runner/model, emit JSON
node dist/cli.js eval learning-policy --runner claude --model claude-opus-4-8 --json
```

## Cases & sourcing (learning-policy write-back)

Each case carries a `task` + a `completed-session` fixture (a faithful "what
just happened"); the harness renders the real worker prompt for the case's
`action`, appends the session, and grades the emitted `learningMutations`.

The case set is **seeded from real worker traces**, not imagined. The sourcing
pass (ENG-5342) mined 244 retained prompt+output pairs from the live
`automation-pilot` workspace and error-analysed the 27 record / 207 decline
decisions against the learning policy, deriving cases across a behaviour
taxonomy: reusable-insight (shared + repo scope), routine-decline (mechanical +
idempotent re-check), over-eager-on-one-off, multi-learning, and two ambiguous
cases — where the per-sample **pass-rate**, not a crisp pass, is the signal. Two
hand-authored cases anchor the clearest reusable / no-learning poles.

Fidelity notes:
- Seed traces were generated under a prior revision of the learning-policy
  fragment; cases run against the **current** fragment. The behaviour under test
  (record vs decline, scope, structure) is unchanged, so this doesn't weaken them.
- **Still not evaluated:** the `foreman learnings search` / dedup step and
  `update` mutations. They need a seeded learnings store — 0/244 live prompts
  inject existing learnings (the worker searches at runtime), so a stateless run
  starts empty. The dedup behaviour is *documented* from real traces (duplicate
  records that should have been updates; correct updates) and deferred to the
  seeded-store increment.

## Cases & sourcing (summary-policy)

The summary-policy eval (ENG-5444) grades the `summary` field the same
synthetic-session scaffold produces — the harness renders the worker prompt,
appends a session, and the graders inspect the emitted `summary` rather than the
`learningMutations`. Bar (`prompts/fragments/summary-policy.md`): concise, names
the meaningful outcome (not every step), prefer one sentence, name the blocker
clearly when blocked.

The case set is **derived from real traces**, error-analysed in
[`analysis/summary-policy-error-analysis.md`](analysis/summary-policy-error-analysis.md)
across 296 live summaries (76.4% good). Each negative case is a scenario
engineered to tempt an observed failure mode, sourced from the trace that
exhibited it: a telemetry-rich no-action polling pass tempts the **over-long**
mode; a session carrying raw `PRRT_` GraphQL thread node ids tempts the
**jargon-id** mode; a pure rename tempts file-by-file narration. The positive
cases anchor the good shapes (clean completed, concise stand-down, multi-part
merge-conflict resolution, a clearly-named blocker).

Graders: `schema` (reused, prompt-agnostic), `outcome` (matches the warranted
outcome), `conciseness` (the empirical ceiling — ≤3 sent / ≤450 chars standard,
relaxed to ≤6 / ~700 for `lengthBar: "multiPart"` completed work, p95 of good =
444c; a ceiling, never a floor), `mentions` (case-insensitive mustMention /
mustNotMention plus an always-on `PRRT_` opaque-id check), and an **advisory**
`fabrication` judge (binary PASS/FAIL on whether the summary overclaims, e.g.
asserting full verification when a step was deferred). The conciseness sentence
splitter protects decimals/versions and dotted identifiers per the report.

Fidelity / gaps:
- The conciseness constants are the empirical good-summary distribution, not an
  invented cap. Provenance is commented on `SUMMARY_LENGTH_BARS`.
- The corpus has only **one** blocked trace (a good one) and **no** vague /
  fabricated / overclaimed negatives, so the `blocked-second-scenario` case is
  marked `SYNTHETIC`. The `jargon-id` mode is anchored on `PRRT_` only — other
  opaque-id shapes are unobserved and intentionally not invented.
- The `fabrication` judge is **advisory** (uncalibrated; never gates) — the
  honesty nuance it targets is a weak signal (2/40 execution traces).

## Cases & sourcing (reviewer)

The reviewer eval (ENG-5444) grades the reviewer action's *decision*, not an
end-of-run reflection — so it carries a **`pr-review` fixture** instead of the
completed-session scaffold: a synthetic `pullRequestReference` rendered into the
real reviewer (or reviewer-continuation) template, a pre-resolved
`priorCheckpoint` for continuation cases, and a `discovery` block handed over
post-render as the complete, faithful result of the `gh` PR discovery the
reviewer would otherwise run (the eval forbids live `gh`/git discovery and
subagent fan-out — see `syntheticPrReviewBlock`).

The case set is **derived from real traces**, error-analysed in
[`analysis/reviewer-error-analysis.md`](analysis/reviewer-error-analysis.md)
across 123 live reviewer attempts (74% good). The failure mass lives in exactly
two prose modes — **summary-overlong** on continuation stand-downs (24/27
current-era bads; root cause was the continuation template missing the
summary-policy fragment, fixed alongside this eval) and **finding-in-body** on
completed reviews (3 bads, 1038–1387c bodies vs a 682c good ceiling). The
reviewer's *verdict* was never observed wrong, so the planted-bug case is marked
`SYNTHETIC` (a missed finding can't be re-derived from the harvest — it carries
PR metadata, not the diff).

Graders (`reviewer-graders.ts`, all deterministic — no judge, no signals; both
de-scoped by the analysis): `schema` (reused), `outcome`, `review-mutation`
(structural conformance: zero mutations on a stand-down; exactly one
`submit_pull_request_review` with `event: "COMMENT"`, ≥1 path+line-pinned inline
comment, no task mutations — 100% clean across the 23 real completed traces, so
this is a regression guard), `summary-conciseness` (stand-downs only; the
summary-policy standard ceiling — reviewer first_pass good summaries max at
363c), `body-discipline` (completed only; body ≤900c AND shorter than its
largest inline comment — good reviews keep the weight in the thread), and
`mentions` (durable path tokens pinned by inline comments).

## Cases & sourcing (reviewer-live)

The layer-2 counterpart of the reviewer eval: instead of a synthetic discovery
block, each case carries a **`live-pr` fixture** pointing at a frozen fixture
PR in [`invenco/foreman-bench`](https://github.com/invenco/foreman-bench) (a
minimal parcel-quotes service with planted findings). The harness clones the
bench repo into the eval workspace, force-checkouts the case branch at its
**manifest-pinned head sha** (an unreachable sha fails the run loudly — frozen
fixtures must never drift silently), renders the real reviewer prompt against
that worktree, and lets the reviewer run its own live `gh` discovery. The
worker result is captured and graded, **never applied** — zero GitHub writes,
so the fixture PRs stay byte-frozen across runs. Do not merge, close, or
comment on the fixture PRs.

Continuation cases (`continuation: true` in the manifest) select the
reviewer-continuation template and carry a driver-side `priorCheckpoint`
pinning a real seeded review on the fixture PR (its review node id and thread
fingerprint). Each fixture PR carries at most ONE seeded COMMENT review — a
sanctioned one-time exception to the freeze, recorded in the manifest note.
The three continuation shapes: nothing-new (stand down, no re-litigation of
the still-open seeded thread), fix-verified (commits since the checkpoint
address the thread → stand down), and bad-fix (the "fix" contradicts the
requested change → flag it).

Expectations live in `cases/foreman-bench-manifest.json` — driver-side, never
in the bench repo, because the reviewer explores its worktree during a pass and
an in-repo manifest naming the planted findings would contaminate every case.

Graders (`live-pr-graders.ts`, all deterministic): `outcome`, `mutation-shape`
(one COMMENT review for completed; zero mutations for a stand-down),
`planted-paths` (the planted file pinned by an inline comment), `thread-count`
(nit-bait discipline), `body-discipline` (body < largest inline comment), and
`summary-length` (stand-down ceiling).

Live runs need `gh` authenticated for the bench repo and take ~5–11 min per
sample: `foreman eval reviewer-live --samples 1 --timeout 1500000 --runner codex`.
Samples record `tokensUsed` and `elapsedSeconds` for cost-per-quality tracking.

## Judge calibration

The `quality` judge is **advisory** (it never gates a sample) and was calibrated
against human-labelled learnings (ENG-5342). Full method, per-item verdicts, and
iteration history are in [`calibration/`](./calibration/).

These numbers are for the judge prompt on **claude-sonnet-4-6**. The judge runs on the
eval's execution-runner model, whose default is `opencode / gpt-5.5` — so the
default-config judge is uncalibrated; reproduce these numbers with
`--runner claude --model claude-sonnet-4-6`.

| | rate | note |
|---|---|---|
| TPR real positives    | 25/25 = 100% | keeps genuinely-reusable learnings, incl. empirically-reused ones |
| TNR constructed junk  | 6/6 = 100%   | |
| TNR held-out one-offs | 4/5 = 80%    | held-out validation (fresh narrow facts/configs/incidents) |
| TPR held-out rules    | 4/4 = 100%   | held-out validation (fresh broad rules) |
| TNR real "negatives"  | 0/4 = 0%     | but these are *defensibly reusable* — see below |

The judge reliably separates clear one-offs from clear reusable rules (14/15 on the
unambiguous held-out + constructed cases). The 0/4 on the real-trace "negatives" is
**largely a labelling artifact, not a judge failure**: those four are defensibly
reusable (the judge's transfer arguments hold), so the strict bar was harsher than a
reasonable reading. It stays advisory — gating would need a larger, independently
annotated negative set and an agreed bar.

Two findings worth carrying forward:
- **A content-judge can't reliably catch over-eager recording** — over-eager learnings
  are *written* to read as reusable. The durable signal is **empirical reuse**: only
  4/30 stored learnings were ever applied (`applied_count > 0`).
- A blunt "must be broadly transferable" judge prompt backfired (cratered TPR by
  rejecting repo-internal-but-reusable rules); the shipped prompt targets *one-off
  facts*, not *repo-specificity*.

> Note: the judge is a pure grading call, so its invoker runs the agent CLI with MCP
> disabled (via `createAgentRunner({ excludeMcp: true })`) — running `eval` with the
> judge does not trigger MCP auth prompts. Honoured by claude (`--strict-mcp-config`)
> and codex (`-c mcp_servers={}`); a no-op for opencode, which exposes no
> per-invocation MCP-disable flag, so an opencode judge keeps its configured MCP.

## Adding a prompt

Add a `defineEval({...})` entry to `EVAL_REGISTRY` with the prompt's cases and
graders — `defineEval` type-checks that both agree on one `Expect` shape before
the registry erases it (the erased registry plus bivariant `grade()` would
otherwise let a mismatched pairing through to runtime). Reuse the deterministic
graders where they apply; add prompt-specific graders or a tailored judge rubric
as needed.

`EvalCase<Expect>` is generic over a **per-prompt expectation payload**. The
harness core never inspects `expect` — only that prompt's graders do — so each
prompt defines its own shape and narrows its graders to it (e.g. learning-policy
uses `LearningExpect = { decision; scope? }` and types its graders
`Grader<LearningExpect>`). The case's `fixture` is a discriminated union: the
end-of-run prompts use the `completed-session` scaffold, the reviewer uses the
`pr-review` fixture. A prompt whose behaviour fits neither shape adds a new
fixture variant and a matching branch in `assembleCasePrompt`.
