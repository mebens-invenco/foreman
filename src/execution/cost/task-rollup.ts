/**
 * Aggregates raw {@link AttemptTaskRow} rows into per-task buckets with
 * computed USD cost. Backs the HTTP `/api/task-rollups` endpoint that powers
 * the work-items table in the UI.
 *
 * Naming note: every bucket is a `Task` (the rollup keys on `taskId` and the
 * SQL upstream filters cron rows via `task_id IS NOT NULL`). The user-facing
 * page label is "Work items" because that's the product-side surface name,
 * but the code-side object IS a task — see `src/domain/task.ts` for the
 * domain aggregate this enriches with attempt-derived data.
 *
 * Cost math mirrors {@link rollupUsage}: estimated per row so each row's
 * own runner/model rate is honoured, then summed into the bucket. The shape
 * differs from usage rollup because the user question is "what happened on
 * this ticket" rather than "how much did we spend per runner/day" — we
 * carry per-target latest status, an effective ticket-wide status, and the
 * first/last seen timestamps inside the window.
 */
import type { AttemptStatus, TokenUsage } from "../../domain/index.js";
import type { AttemptTaskRow } from "../../repos/attempt-repo.js";

import { estimateCost, type CostBreakdown } from "./cost-estimator.js";

export type TaskTargetStatus = {
  target: string;
  status: AttemptStatus;
};

export type TaskRollupBucket = {
  taskId: string;
  targets: string[];
  perTargetLatestStatus: TaskTargetStatus[];
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

export type TaskRollupTotals = {
  attemptsCount: number;
  tokens: Required<TokenUsage>;
  cost: {
    totalUsd: number;
    breakdown: CostBreakdown;
  };
};

export type TaskRollup = {
  fromInclusive: string;
  toExclusive: string;
  buckets: TaskRollupBucket[];
  totals: TaskRollupTotals;
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

const emptyTotals = (): TaskRollupTotals => ({
  attemptsCount: 0,
  tokens: emptyTokens(),
  cost: { totalUsd: 0, breakdown: emptyBreakdown() },
});

/**
 * Re-compute totals from a (possibly filtered) bucket list. Used when the
 * HTTP layer applies `status`/`search` filters after rollup — totals must
 * stay aligned with the buckets actually returned, otherwise totals and
 * the sum of buckets diverge for any non-empty filter.
 */
export const sumTaskRollupTotals = (
  buckets: readonly Pick<TaskRollupBucket, "attemptsCount" | "tokens" | "cost">[],
): TaskRollupTotals => {
  const totals = emptyTotals();
  for (const bucket of buckets) {
    totals.attemptsCount += bucket.attemptsCount;
    totals.tokens.inputTokens += bucket.tokens.inputTokens;
    totals.tokens.outputTokens += bucket.tokens.outputTokens;
    totals.tokens.cacheCreationInputTokens += bucket.tokens.cacheCreationInputTokens;
    totals.tokens.cacheReadInputTokens += bucket.tokens.cacheReadInputTokens;
    totals.tokens.reasoningOutputTokens += bucket.tokens.reasoningOutputTokens;
    totals.cost.totalUsd += bucket.cost.totalUsd;
    totals.cost.breakdown.input += bucket.cost.breakdown.input;
    totals.cost.breakdown.output += bucket.cost.breakdown.output;
    totals.cost.breakdown.cacheRead += bucket.cost.breakdown.cacheRead;
    totals.cost.breakdown.cacheCreate += bucket.cost.breakdown.cacheCreate;
    totals.cost.breakdown.reasoning += bucket.cost.breakdown.reasoning;
  }
  return totals;
};

type Aggregator = {
  taskId: string;
  rows: AttemptTaskRow[];
  attemptsCount: number;
  tokens: Required<TokenUsage>;
  cost: { totalUsd: number; breakdown: CostBreakdown };
  firstSeenInWindow: string;
  lastStartedAt: string;
  lastFinishedAt: string | null;
};

const createAggregator = (taskId: string, row: AttemptTaskRow): Aggregator => ({
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
  aggregator: Aggregator | TaskRollupTotals,
  row: AttemptTaskRow,
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
 *   4. else                       → most recent of remaining rows (completed or canceled),
 *                                   tie-broken by started_at then attempt_number
 *
 * Step 4 means a newest `canceled` attempt surfaces as the effective status
 * when no live/blocked/failed attempt remains — there is no implicit
 * preference for `completed` over `canceled` once both buckets are drained.
 *
 * Why not "latest started, full stop": a still-running older attempt should
 * not be hidden behind a stale `completed` that started earlier. And ties on
 * `started_at` are non-deterministic without a second key because
 * `attempt_number` is job-scoped, not ticket-scoped — one ticket can have
 * multiple jobs with overlapping numbers.
 */
const failureStatuses: ReadonlySet<AttemptStatus> = new Set(["failed", "timed_out"]);

const compareForLatest = (a: AttemptTaskRow, b: AttemptTaskRow): number => {
  if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  if (a.attemptNumber !== b.attemptNumber) {
    return a.attemptNumber < b.attemptNumber ? -1 : 1;
  }
  return 0;
};

const latestOf = (rows: AttemptTaskRow[]): AttemptTaskRow =>
  rows.reduce((latest, row) => (compareForLatest(row, latest) > 0 ? row : latest));

export const computeEffectiveStatus = (rows: AttemptTaskRow[]): AttemptStatus => {
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

const computePerTargetLatest = (rows: AttemptTaskRow[]): TaskTargetStatus[] => {
  const byTarget = new Map<string, AttemptTaskRow[]>();
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

export const rollupTasks = (input: {
  rows: AttemptTaskRow[];
  fromInclusive: string;
  toExclusive: string;
}): TaskRollup => {
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
    .map((aggregator): TaskRollupBucket => {
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
