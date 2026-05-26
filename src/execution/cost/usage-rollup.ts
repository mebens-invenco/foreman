/**
 * Aggregates raw {@link AttemptUsageRow} rows into per-bucket usage summaries
 * with computed USD cost. Shared by the HTTP `/api/usage` endpoint and the
 * `foreman usage` CLI command so both produce identical totals for the same
 * input window.
 *
 * Cost is computed at read time via {@link estimateCost} — no value is stored.
 * If the rate table changes, regenerating the rollup against the same window
 * is the only update needed.
 */
import type { TokenUsage } from "../../domain/index.js";
import type { AttemptUsageRow } from "../../repos/attempt-repo.js";

import { estimateCost, type CostBreakdown } from "./cost-estimator.js";

export type UsageGroupBy = "day" | "runner" | "model";

const groupByValues = ["day", "runner", "model"] as const satisfies readonly UsageGroupBy[];

export const usageGroupByValues = groupByValues;

export const isUsageGroupBy = (value: string): value is UsageGroupBy =>
  (groupByValues as readonly string[]).includes(value);

export type UsageBucket = {
  groupKey: string;
  attemptsCount: number;
  tokens: Required<TokenUsage>;
  cost: {
    totalUsd: number;
    breakdown: CostBreakdown;
  };
};

export type UsageRollup = {
  groupBy: UsageGroupBy;
  fromInclusive: string;
  toExclusive: string;
  buckets: UsageBucket[];
  totals: UsageBucket;
};

const dayKey = (isoTimestamp: string): string => isoTimestamp.slice(0, 10);

const groupKeyFor = (groupBy: UsageGroupBy, row: AttemptUsageRow): string => {
  switch (groupBy) {
    case "day":
      return dayKey(row.startedAt);
    case "runner":
      return row.runnerName;
    case "model":
      return `${row.runnerName}/${row.runnerModel}`;
  }
};

const emptyTokens = (): Required<TokenUsage> => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningOutputTokens: 0,
});

const emptyBreakdown = (): CostBreakdown => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  reasoning: 0,
});

const emptyBucket = (groupKey: string): UsageBucket => ({
  groupKey,
  attemptsCount: 0,
  tokens: emptyTokens(),
  cost: { totalUsd: 0, breakdown: emptyBreakdown() },
});

const accumulate = (bucket: UsageBucket, row: AttemptUsageRow): void => {
  bucket.attemptsCount += 1;
  const tokens = row.tokensUsed;
  if (tokens) {
    bucket.tokens.inputTokens += tokens.inputTokens;
    bucket.tokens.outputTokens += tokens.outputTokens;
    bucket.tokens.cacheCreationInputTokens += tokens.cacheCreationInputTokens ?? 0;
    bucket.tokens.cacheReadInputTokens += tokens.cacheReadInputTokens ?? 0;
    bucket.tokens.reasoningOutputTokens += tokens.reasoningOutputTokens ?? 0;
  }

  // Cost is computed per row (not from the running token totals) because the
  // rate depends on the row's runner/model triple, which can differ between
  // rows even inside one bucket — e.g. day buckets mix every runner that ran
  // that day. Summing per-row preserves the right rate per row.
  const estimate = estimateCost(tokens, row.runnerName, row.runnerModel, row.runnerVariant);
  bucket.cost.totalUsd += estimate.totalUsd;
  bucket.cost.breakdown.input += estimate.breakdown.input;
  bucket.cost.breakdown.output += estimate.breakdown.output;
  bucket.cost.breakdown.cacheRead += estimate.breakdown.cacheRead;
  bucket.cost.breakdown.cacheCreate += estimate.breakdown.cacheCreate;
  bucket.cost.breakdown.reasoning += estimate.breakdown.reasoning;
};

export const rollupUsage = (input: {
  rows: AttemptUsageRow[];
  groupBy: UsageGroupBy;
  fromInclusive: string;
  toExclusive: string;
}): UsageRollup => {
  const bucketsByKey = new Map<string, UsageBucket>();
  const totals = emptyBucket("__all__");

  for (const row of input.rows) {
    const key = groupKeyFor(input.groupBy, row);
    let bucket = bucketsByKey.get(key);
    if (!bucket) {
      bucket = emptyBucket(key);
      bucketsByKey.set(key, bucket);
    }
    accumulate(bucket, row);
    accumulate(totals, row);
  }

  const buckets = [...bucketsByKey.values()].sort((a, b) => a.groupKey.localeCompare(b.groupKey));

  return {
    groupBy: input.groupBy,
    fromInclusive: input.fromInclusive,
    toExclusive: input.toExclusive,
    buckets,
    totals,
  };
};
