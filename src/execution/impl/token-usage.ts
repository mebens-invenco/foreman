/**
 * Runner-agnostic helper for combining `TokenUsage` rows.
 *
 * Per-runner token extraction lives in each runner's sibling output module.
 * This module exposes only the summing helper used by `attempt-executor` to
 * aggregate per-attempt rows and by individual runners that emit per-step
 * deltas.
 *
 * Each runner's extractor normalizes raw provider counts to a consistent
 * shape — `inputTokens` always means "new (non-cached) input tokens" —
 * which makes summing per-call values produce a meaningful session total.
 */
import type { TokenUsage } from "../../domain/index.js";

export const sumTokenUsage = (
  totals: TokenUsage | undefined,
  addend: TokenUsage | undefined,
): TokenUsage | undefined => {
  if (!addend) {
    return totals;
  }
  if (!totals) {
    return { ...addend };
  }

  const next: TokenUsage = {
    inputTokens: totals.inputTokens + addend.inputTokens,
    outputTokens: totals.outputTokens + addend.outputTokens,
  };

  if (totals.cacheCreationInputTokens !== undefined || addend.cacheCreationInputTokens !== undefined) {
    next.cacheCreationInputTokens =
      (totals.cacheCreationInputTokens ?? 0) + (addend.cacheCreationInputTokens ?? 0);
  }
  if (totals.cacheReadInputTokens !== undefined || addend.cacheReadInputTokens !== undefined) {
    next.cacheReadInputTokens =
      (totals.cacheReadInputTokens ?? 0) + (addend.cacheReadInputTokens ?? 0);
  }
  if (totals.reasoningOutputTokens !== undefined || addend.reasoningOutputTokens !== undefined) {
    next.reasoningOutputTokens =
      (totals.reasoningOutputTokens ?? 0) + (addend.reasoningOutputTokens ?? 0);
  }

  return next;
};
