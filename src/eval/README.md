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

- **deterministic** — schema valid, exactly one matching action tag, required
  `**Rule:** / **When to apply:**` content structure. Cheap, exact; they cover
  what the loose worker-result Zod schema lets through.
- **LLM-as-judge** (`quality`, **advisory**) — a binary yes/no on what structure
  can't see: is the learning a reusable rule, or just a restatement of the task?
  Reported but does **not** gate a sample's pass until it is calibrated against
  human labels (TPR/TNR). `--no-judge` disables it.

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

## v1 scope (learning-policy write-back)

- **Synthetic sessions** — cases inject a simulated "completed session" and grade
  the emitted `learningMutations`. Faithful enough to grade the write-back
  decision/structure; it is not a real end-to-end run.
- **Not yet evaluated:** the `foreman learnings search` / dedup step and
  `update` mutations (need a seeded learnings store — the store seam), and
  real (non-synthetic) end-to-end cases. Both are later fidelity upgrades.

## Adding a prompt

Add an `EvalDefinition` to `EVAL_REGISTRY` with its cases and graders. Reuse
the deterministic graders where they apply; add prompt-specific graders or a
tailored judge rubric as needed.
