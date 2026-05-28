/**
 * Aggregates raw {@link AttemptWorkItemRow} rows into per-ticket work-item
 * buckets with computed USD cost. Backs the HTTP `/api/work-items` endpoint
 * that powers the work-items table in the UI.
 *
 * Cost math mirrors {@link rollupUsage}: estimated per row so each row's
 * own runner/model rate is honoured, then summed into the bucket. The shape
 * differs from usage rollup because the user question is "what happened on
 * this ticket" rather than "how much did we spend per runner/day" — we
 * carry per-target latest status, an effective ticket-wide status, and the
 * first/last seen timestamps inside the window.
 */
import type { AttemptStatus, TokenUsage } from "../../domain/index.js";
import type { AttemptWorkItemRow } from "../../repos/attempt-repo.js";

import { estimateCost, type CostBreakdown } from "./cost-estimator.js";

export type WorkItemPerTargetStatus = {
  target: string;
  status: AttemptStatus;
};

export type WorkItemBucket = {
  taskId: string;
  targets: string[];
  perTargetLatestStatus: WorkItemPerTargetStatus[];
  effectiveStatus: AttemptStatus;
  attemptsCount: number;
  firstSeenInWindow: string;
  lastStartedAt: string;
  lastFinishedAt: string | null;
  tokens: Required<TokenUsage>;
  cost: {
    totalUsd: number;
    breakdown: CostBreakdown;
  };
};

export type WorkItemTotals = {
  attemptsCount: number;
  tokens: Required<TokenUsage>;
  cost: {
    totalUsd: number;
    breakdown: CostBreakdown;
  };
};

export type WorkItemRollup = {
  fromInclusive: string;
  toExclusive: string;
  buckets: WorkItemBucket[];
  totals: WorkItemTotals;
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

const emptyTotals = (): WorkItemTotals => ({
  attemptsCount: 0,
  tokens: emptyTokens(),
  cost: { totalUsd: 0, breakdown: emptyBreakdown() },
});

type Aggregator = {
  taskId: string;
  rows: AttemptWorkItemRow[];
  attemptsCount: number;
  tokens: Required<TokenUsage>;
  cost: { totalUsd: number; breakdown: CostBreakdown };
  firstSeenInWindow: string;
  lastStartedAt: string;
  lastFinishedAt: string | null;
};

const createAggregator = (taskId: string, row: AttemptWorkItemRow): Aggregator => ({
  taskId,
  rows: [],
  attemptsCount: 0,
  tokens: emptyTokens(),
  cost: { totalUsd: 0, breakdown: emptyBreakdown() },
  firstSeenInWindow: row.startedAt,
  lastStartedAt: row.startedAt,
  lastFinishedAt: row.finishedAt,
});

const earlier = (a: string, b: string): string => (a <= b ? a : b);

const later = (a: string, b: string): string => (a >= b ? a : b);

const laterNullable = (current: string | null, candidate: string | null): string | null => {
  if (candidate === null) {
    return current;
  }
  if (current === null) {
    return candidate;
  }
  return later(current, candidate);
};

const accumulateTokensAndCost = (
  aggregator: Aggregator | WorkItemTotals,
  row: AttemptWorkItemRow,
): void => {
  aggregator.attemptsCount += 1;
  const tokens = row.tokensUsed;
  if (tokens) {
    aggregator.tokens.inputTokens += tokens.inputTokens;
    aggregator.tokens.outputTokens += tokens.outputTokens;
    aggregator.tokens.cacheCreationInputTokens += tokens.cacheCreationInputTokens ?? 0;
    aggregator.tokens.cacheReadInputTokens += tokens.cacheReadInputTokens ?? 0;
    aggregator.tokens.reasoningOutputTokens += tokens.reasoningOutputTokens ?? 0;
  }

  // Same rationale as usage-rollup: estimate per row so the row's own
  // runner/model rate applies, then sum into the bucket.
  const estimate = estimateCost(tokens, row.runnerName, row.runnerModel);
  aggregator.cost.totalUsd += estimate.totalUsd;
  aggregator.cost.breakdown.input += estimate.breakdown.input;
  aggregator.cost.breakdown.output += estimate.breakdown.output;
  aggregator.cost.breakdown.cacheRead += estimate.breakdown.cacheRead;
  aggregator.cost.breakdown.cacheCreate += estimate.breakdown.cacheCreate;
  aggregator.cost.breakdown.reasoning += estimate.breakdown.reasoning;
};

/**
 * Effective status policy:
 *   1. any `running`              → running
 *   2. else any `blocked`         → blocked
 *   3. else any failure-y status  → most recent failure (started_at, then attempt_number)
 *   4. else                       → most recent completion (started_at, then attempt_number)
 *
 * Why not "latest started, full stop": a still-running older attempt should
 * not be hidden behind a stale `completed` that started earlier. And ties on
 * `started_at` are non-deterministic without a second key because
 * `attempt_number` is job-scoped, not ticket-scoped — one ticket can have
 * multiple jobs with overlapping numbers.
 */
const failureStatuses: ReadonlySet<AttemptStatus> = new Set(["failed", "timed_out"]);

const compareForLatest = (a: AttemptWorkItemRow, b: AttemptWorkItemRow): number => {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  if (a.attemptNumber !== b.attemptNumber) {
    return a.attemptNumber < b.attemptNumber ? -1 : 1;
  }
  return 0;
};

const latestOf = (rows: AttemptWorkItemRow[]): AttemptWorkItemRow =>
  rows.reduce((latest, row) => (compareForLatest(row, latest) > 0 ? row : latest));

export const computeEffectiveStatus = (rows: AttemptWorkItemRow[]): AttemptStatus => {
  if (rows.some((row) => row.status === "running")) {
    return "running";
  }
  if (rows.some((row) => row.status === "blocked")) {
    return "blocked";
  }
  const failures = rows.filter((row) => failureStatuses.has(row.status));
  if (failures.length > 0) {
    return latestOf(failures).status;
  }
  return latestOf(rows).status;
};

const computePerTargetLatest = (rows: AttemptWorkItemRow[]): WorkItemPerTargetStatus[] => {
  const byTarget = new Map<string, AttemptWorkItemRow[]>();
  for (const row of rows) {
    if (row.target === null) {
      continue;
    }
    const list = byTarget.get(row.target);
    if (list) {
      list.push(row);
    } else {
      byTarget.set(row.target, [row]);
    }
  }
  return [...byTarget.entries()]
    .map(([target, targetRows]) => ({
      target,
      status: computeEffectiveStatus(targetRows),
    }))
    .sort((a, b) => a.target.localeCompare(b.target));
};

export const rollupWorkItems = (input: {
  rows: AttemptWorkItemRow[];
  fromInclusive: string;
  toExclusive: string;
}): WorkItemRollup => {
  const aggregatorsByTaskId = new Map<string, Aggregator>();
  const totals = emptyTotals();

  for (const row of input.rows) {
    let aggregator = aggregatorsByTaskId.get(row.taskId);
    if (!aggregator) {
      aggregator = createAggregator(row.taskId, row);
      aggregatorsByTaskId.set(row.taskId, aggregator);
    } else {
      aggregator.firstSeenInWindow = earlier(aggregator.firstSeenInWindow, row.startedAt);
      aggregator.lastStartedAt = later(aggregator.lastStartedAt, row.startedAt);
      aggregator.lastFinishedAt = laterNullable(aggregator.lastFinishedAt, row.finishedAt);
    }
    aggregator.rows.push(row);
    accumulateTokensAndCost(aggregator, row);
    accumulateTokensAndCost(totals, row);
  }

  const buckets = [...aggregatorsByTaskId.values()]
    .map((aggregator): WorkItemBucket => {
      const targets = [
        ...new Set(
          aggregator.rows
            .map((row) => row.target)
            .filter((target): target is string => target !== null),
        ),
      ].sort((a, b) => a.localeCompare(b));

      return {
        taskId: aggregator.taskId,
        targets,
        perTargetLatestStatus: computePerTargetLatest(aggregator.rows),
        effectiveStatus: computeEffectiveStatus(aggregator.rows),
        attemptsCount: aggregator.attemptsCount,
        firstSeenInWindow: aggregator.firstSeenInWindow,
        lastStartedAt: aggregator.lastStartedAt,
        lastFinishedAt: aggregator.lastFinishedAt,
        tokens: aggregator.tokens,
        cost: aggregator.cost,
      };
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId));

  return {
    fromInclusive: input.fromInclusive,
    toExclusive: input.toExclusive,
    buckets,
    totals,
  };
};
