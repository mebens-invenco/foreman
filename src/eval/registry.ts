import { learningPolicyCases } from "./cases/learning-policy.js";
import { learningWritebackGraders } from "./graders.js";
import type { EvalDefinition } from "./types.js";

/**
 * The eval corpus, keyed by prompt. Adding a prompt to the framework is a
 * registry entry + a case set + (optionally) prompt-specific graders — not a
 * new harness. v1 implements the learning-policy write-back only.
 */
export const EVAL_REGISTRY: Record<string, EvalDefinition> = {
  "learning-policy": {
    prompt: "learning-policy",
    cases: learningPolicyCases,
    graders: learningWritebackGraders,
  },
};

export const evalPromptNames = Object.keys(EVAL_REGISTRY);
