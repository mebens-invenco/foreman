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

  return next;
};
