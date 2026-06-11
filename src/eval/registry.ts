import { learningPolicyCases } from "./cases/learning-policy.js";
import { learningWritebackGraders } from "./graders.js";
import type { EvalDefinition } from "./types.js";

/**
 * The eval corpus, keyed by prompt. Adding a prompt is a registry entry + a case
 * set + (optionally) prompt-specific graders — not a new harness. Each prompt
 * carries its own `EvalCase<Expect>` expectation shape, which the registry erases
 * to `EvalDefinition` here (the core never reads `expect`; only that prompt's
 * graders do). Currently registers the learning-policy write-back.
 */
export const EVAL_REGISTRY: Record<string, EvalDefinition> = {
  "learning-policy": {
    prompt: "learning-policy",
    cases: learningPolicyCases,
    graders: learningWritebackGraders,
  },
};

export const evalPromptNames = Object.keys(EVAL_REGISTRY);
