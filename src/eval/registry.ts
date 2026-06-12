import { learningPolicyCases } from "./cases/learning-policy.js";
import { learningWritebackGraders } from "./graders.js";
import type { EvalDefinition } from "./types.js";

/**
 * Checks a definition's cases and graders agree on ONE `Expect` shape before the
 * registry erases it. The registry stores type-erased `EvalDefinition`s (the core
 * never reads `expect`), and `grade()` is bivariant — so without this construction
 * gate, a case set from one prompt could silently pair with graders from another
 * and only fail at runtime. Always build registry entries through this.
 */
const defineEval = <Expect>(definition: EvalDefinition<Expect>): EvalDefinition => definition as EvalDefinition;

/**
 * The eval corpus, keyed by prompt. Adding a prompt is a `defineEval` entry + a
 * case set + (optionally) prompt-specific graders — not a new harness. Each
 * prompt carries its own `EvalCase<Expect>` expectation shape, type-checked as a
 * consistent pairing by `defineEval`, then erased here (the core never reads
 * `expect`; only that prompt's graders do). Currently registers the
 * learning-policy write-back.
 */
export const EVAL_REGISTRY: Record<string, EvalDefinition> = {
  "learning-policy": defineEval({
    prompt: "learning-policy",
    cases: learningPolicyCases,
    graders: learningWritebackGraders,
  }),
};

export const evalPromptNames = Object.keys(EVAL_REGISTRY);
