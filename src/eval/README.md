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

Each case carries a `task` + a `syntheticSession` (a faithful "what just
happened"); the harness renders the real worker prompt for the case's `action`,
appends the session, and grades the emitted `learningMutations`.

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
> disabled (claude: `--strict-mcp-config`, via `createAgentRunner({ excludeMcp: true })`)
> — running `eval` with the judge does not trigger MCP auth prompts.

## Adding a prompt

Add an `EvalDefinition` to `EVAL_REGISTRY` with its cases and graders. Reuse
the deterministic graders where they apply; add prompt-specific graders or a
tailored judge rubric as needed.
