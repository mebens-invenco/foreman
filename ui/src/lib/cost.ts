import type { TokenUsage, UsageRate } from "@/lib/api"

/**
 * Client-side cost helper. The rate table itself lives on the server
 * (`src/execution/cost/rates.ts`) and is fetched via `useRatesQuery` so
 * the UI cannot drift from `/api/usage`. Callers pass the hydrated
 * `rates` array in; this module only does lookup + arithmetic.
 */

const TOKENS_PER_MTOK = 1_000_000

const buildKey = (runnerName: string, runnerModel: string, runnerVariant: string): string =>
  `${runnerName}|${runnerModel}|${runnerVariant}`

export type CostBreakdown = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  reasoning: number
}

export type CostEstimate = {
  totalUsd: number
  breakdown: CostBreakdown
  rateApplied: UsageRate | null
}

const zeroBreakdown = (): CostBreakdown => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  reasoning: 0,
})

const zeroEstimate = (rateApplied: UsageRate | null): CostEstimate => ({
  totalUsd: 0,
  breakdown: zeroBreakdown(),
  rateApplied,
})

export function lookupRate(
  rates: UsageRate[] | undefined,
  runnerName: string,
  runnerModel: string,
  runnerVariant: string
): UsageRate | null {
  if (!rates) {
    return null
  }
  const key = buildKey(runnerName, runnerModel, runnerVariant)
  return rates.find((rate) => buildKey(rate.runnerName, rate.runnerModel, rate.runnerVariant) === key) ?? null
}

export function estimateCost(
  tokens: TokenUsage | null,
  runnerName: string,
  runnerModel: string,
  runnerVariant: string,
  rates: UsageRate[] | undefined
): CostEstimate {
  const rate = lookupRate(rates, runnerName, runnerModel, runnerVariant)

  if (!tokens || !rate) {
    return zeroEstimate(rate)
  }

  const breakdown: CostBreakdown = {
    input: (tokens.inputTokens * rate.inputPerMtok) / TOKENS_PER_MTOK,
    output: (tokens.outputTokens * rate.outputPerMtok) / TOKENS_PER_MTOK,
    cacheRead:
      ((tokens.cacheReadInputTokens ?? 0) * rate.cacheReadPerMtok) / TOKENS_PER_MTOK,
    cacheCreate:
      ((tokens.cacheCreationInputTokens ?? 0) * rate.cacheWriteFiveMinPerMtok) /
      TOKENS_PER_MTOK,
    reasoning:
      ((tokens.reasoningOutputTokens ?? 0) * rate.outputPerMtok) / TOKENS_PER_MTOK,
  }

  const totalUsd =
    breakdown.input +
    breakdown.output +
    breakdown.cacheRead +
    breakdown.cacheCreate +
    breakdown.reasoning

  return { totalUsd, breakdown, rateApplied: rate }
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return "$0.00"
  }
  if (value < 0.01) {
    return "<$0.01"
  }
  return `$${value.toFixed(2)}`
}

export function totalAllTokenBuckets(tokens: TokenUsage | null): number | null {
  if (!tokens) {
    return null
  }
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    (tokens.cacheReadInputTokens ?? 0) +
    (tokens.cacheCreationInputTokens ?? 0) +
    (tokens.reasoningOutputTokens ?? 0)
  )
}
