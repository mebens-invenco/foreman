import type { TokenUsage } from "@/lib/api"

/**
 * Mirror of the server-side `rates.ts` table. Kept in sync by hand — both
 * files reference the same vendor pricing pages and should be updated
 * together. Last verified 2026-05-26.
 *
 * The UI computes a cost client-side so the attempts table can show a Cost
 * column without the API round-trip / pagination dance of fetching a
 * per-attempt rollup. Server-side `/api/usage` remains authoritative for
 * rollups (which respect server-side rate updates immediately).
 */
type RunnerRate = {
  inputPerMtok: number
  outputPerMtok: number
  cacheReadPerMtok: number
  cacheWriteFiveMinPerMtok: number
}

const TOKENS_PER_MTOK = 1_000_000

const rateTable: Record<string, RunnerRate> = {
  "claude|claude-opus-4-7|default": {
    inputPerMtok: 15,
    outputPerMtok: 75,
    cacheReadPerMtok: 1.5,
    cacheWriteFiveMinPerMtok: 18.75,
  },
  "claude|claude-sonnet-4-6|default": {
    inputPerMtok: 3,
    outputPerMtok: 15,
    cacheReadPerMtok: 0.3,
    cacheWriteFiveMinPerMtok: 3.75,
  },
  "claude|claude-haiku-4-5-20251001|default": {
    inputPerMtok: 1,
    outputPerMtok: 5,
    cacheReadPerMtok: 0.1,
    cacheWriteFiveMinPerMtok: 1.25,
  },
  "codex|gpt-5.4|default": {
    inputPerMtok: 1.25,
    outputPerMtok: 10,
    cacheReadPerMtok: 0.125,
    cacheWriteFiveMinPerMtok: 1.25,
  },
  "opencode|default|default": {
    inputPerMtok: 3,
    outputPerMtok: 15,
    cacheReadPerMtok: 0.3,
    cacheWriteFiveMinPerMtok: 3.75,
  },
}

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
  rateApplied: RunnerRate | null
}

const zeroEstimate = (rateApplied: RunnerRate | null): CostEstimate => ({
  totalUsd: 0,
  breakdown: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 },
  rateApplied,
})

export function estimateCost(
  tokens: TokenUsage | null,
  runnerName: string,
  runnerModel: string,
  runnerVariant: string
): CostEstimate {
  const rate = rateTable[`${runnerName}|${runnerModel}|${runnerVariant}`] ?? null

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
