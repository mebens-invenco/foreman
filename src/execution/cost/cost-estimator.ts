/**
 * Pure cost estimator: given a {@link TokenUsage} row and the runner that
 * produced it, return a USD breakdown using the hardcoded {@link RunnerRate}
 * table.
 *
 * Unknown runner/model returns an all-zero result rather than throwing, so
 * callers (HTTP, CLI, UI rollups) never crash on a runner not yet wired into
 * the rate table. A single `console.warn` per unknown key per process keeps
 * the visibility without spamming logs.
 *
 * Note on runnerVariant: attempts persist the configured effort/variant
 * ("high", "max", "xhigh", …), but vendor pricing today is model-level for
 * every runner Foreman speaks to, so the lookup intentionally ignores it.
 * See `src/execution/cost/rates.ts` for the rationale.
 *
 * Costs are computed independently per bucket:
 *   - fresh input:     inputPerMtok          x inputTokens
 *   - output:          outputPerMtok         x outputTokens
 *   - cache read:      cacheReadPerMtok      x cacheReadInputTokens
 *   - cache create:    cacheWriteFiveMinPerMtok x cacheCreationInputTokens
 *   - reasoning:       outputPerMtok         x reasoningOutputTokens
 *     (reasoning tokens are billed at the output rate by every vendor we use)
 */
import type { TokenUsage } from "../../domain/index.js";

import { lookupRunnerRate, type RunnerRateKey } from "./rates.js";

export type CostBreakdown = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  reasoning: number;
};

export type CostEstimate = {
  totalUsd: number;
  breakdown: CostBreakdown;
};

const TOKENS_PER_MTOK = 1_000_000;

const warnedKeys = new Set<string>();

const zeroBreakdown = (): CostBreakdown => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  reasoning: 0,
});

const zeroEstimate = (): CostEstimate => ({ totalUsd: 0, breakdown: zeroBreakdown() });

const warnUnknownOnce = (key: RunnerRateKey): void => {
  const cacheKey = `${key.runnerName}|${key.runnerModel}`;
  if (warnedKeys.has(cacheKey)) {
    return;
  }
  warnedKeys.add(cacheKey);
  console.warn(
    `[cost-estimator] No rate entry for runner=${key.runnerName} model=${key.runnerModel} — reporting zero cost.`,
  );
};

export const estimateCost = (
  tokens: TokenUsage | null | undefined,
  runnerName: RunnerRateKey["runnerName"],
  runnerModel: string,
): CostEstimate => {
  if (!tokens) {
    return zeroEstimate();
  }

  const rate = lookupRunnerRate({ runnerName, runnerModel });
  if (!rate) {
    warnUnknownOnce({ runnerName, runnerModel });
    return zeroEstimate();
  }

  const breakdown: CostBreakdown = {
    input: (tokens.inputTokens * rate.inputPerMtok) / TOKENS_PER_MTOK,
    output: (tokens.outputTokens * rate.outputPerMtok) / TOKENS_PER_MTOK,
    cacheRead:
      ((tokens.cacheReadInputTokens ?? 0) * rate.cacheReadPerMtok) /
      TOKENS_PER_MTOK,
    cacheCreate:
      ((tokens.cacheCreationInputTokens ?? 0) * rate.cacheWriteFiveMinPerMtok) /
      TOKENS_PER_MTOK,
    reasoning:
      ((tokens.reasoningOutputTokens ?? 0) * rate.outputPerMtok) /
      TOKENS_PER_MTOK,
  };

  const totalUsd =
    breakdown.input +
    breakdown.output +
    breakdown.cacheRead +
    breakdown.cacheCreate +
    breakdown.reasoning;

  return { totalUsd, breakdown };
};

/**
 * Reset the per-process "warned about this unknown key" memo. Test-only —
 * production code should let the memo build up across the process lifetime.
 */
export const resetUnknownRateWarnings = (): void => {
  warnedKeys.clear();
};
