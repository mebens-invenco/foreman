import { describe, expect, test } from "vitest";

import type { AttemptStatus } from "../../../domain/index.js";
import type { AttemptWorkItemRow } from "../../../repos/attempt-repo.js";
import { computeEffectiveStatus, rollupWorkItems } from "../work-item-rollup.js";

const baseRow = (overrides: Partial<AttemptWorkItemRow> = {}): AttemptWorkItemRow => ({
  taskId: "ENG-1",
  target: "repo-a",
  runnerName: "claude",
  runnerModel: "claude-opus-4-7",
  runnerVariant: "high",
  startedAt: "2026-05-20T10:00:00.000Z",
  finishedAt: "2026-05-20T10:30:00.000Z",
  status: "completed",
  attemptNumber: 1,
  tokensUsed: null,
  ...overrides,
});

describe("computeEffectiveStatus", () => {
  test("returns running when any attempt is still running", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ status: "completed", startedAt: "2026-05-20T08:00:00.000Z" }),
      baseRow({ status: "running", startedAt: "2026-05-20T07:00:00.000Z", attemptNumber: 2 }),
    ];
    expect(computeEffectiveStatus(rows)).toBe<AttemptStatus>("running");
  });

  test("returns blocked when no attempt is running but one is blocked", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ status: "completed", startedAt: "2026-05-20T11:00:00.000Z" }),
      baseRow({ status: "blocked", startedAt: "2026-05-20T09:00:00.000Z", attemptNumber: 2 }),
    ];
    expect(computeEffectiveStatus(rows)).toBe<AttemptStatus>("blocked");
  });

  test("returns the newest failed/timed_out status when no live attempt remains", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ status: "failed", startedAt: "2026-05-20T08:00:00.000Z", attemptNumber: 1 }),
      baseRow({ status: "timed_out", startedAt: "2026-05-20T10:00:00.000Z", attemptNumber: 2 }),
      baseRow({ status: "canceled", startedAt: "2026-05-20T11:00:00.000Z", attemptNumber: 3 }),
    ];
    expect(computeEffectiveStatus(rows)).toBe<AttemptStatus>("timed_out");
  });

  test("breaks startedAt ties using attemptNumber for failures", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ status: "failed", startedAt: "2026-05-20T10:00:00.000Z", attemptNumber: 1 }),
      baseRow({ status: "failed", startedAt: "2026-05-20T10:00:00.000Z", attemptNumber: 3 }),
      baseRow({ status: "failed", startedAt: "2026-05-20T10:00:00.000Z", attemptNumber: 2 }),
    ];
    expect(computeEffectiveStatus(rows)).toBe<AttemptStatus>("failed");
  });

  test("falls back to most recent completion when there are no failures", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ status: "canceled", startedAt: "2026-05-20T08:00:00.000Z", attemptNumber: 1 }),
      baseRow({ status: "completed", startedAt: "2026-05-20T09:00:00.000Z", attemptNumber: 2 }),
    ];
    expect(computeEffectiveStatus(rows)).toBe<AttemptStatus>("completed");
  });

  // There's no implicit preference for completed over canceled once the
  // failure bucket is empty — step 4 picks whichever is newest. Locking the
  // canceled-wins case in so a future "prefer completed" refactor would have
  // to surface and own that policy change.
  test("a newest canceled attempt wins over an older completed attempt", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ status: "completed", startedAt: "2026-05-20T08:00:00.000Z", attemptNumber: 1 }),
      baseRow({ status: "canceled", startedAt: "2026-05-20T09:00:00.000Z", attemptNumber: 2 }),
    ];
    expect(computeEffectiveStatus(rows)).toBe<AttemptStatus>("canceled");
  });
});

describe("rollupWorkItems", () => {
  const fromInclusive = "2026-05-20T00:00:00.000Z";
  const toExclusive = "2026-05-22T00:00:00.000Z";

  test("groups rows by taskId and sums tokens + cost", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({
        taskId: "ENG-1",
        startedAt: "2026-05-20T10:00:00.000Z",
        tokensUsed: { inputTokens: 1_000_000, outputTokens: 0 },
      }),
      baseRow({
        taskId: "ENG-1",
        startedAt: "2026-05-20T18:00:00.000Z",
        attemptNumber: 2,
        tokensUsed: { inputTokens: 0, outputTokens: 1_000_000 },
      }),
    ];

    const result = rollupWorkItems({ rows, fromInclusive, toExclusive });

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]!.attemptsCount).toBe(2);
    expect(result.buckets[0]!.tokens.inputTokens).toBe(1_000_000);
    expect(result.buckets[0]!.tokens.outputTokens).toBe(1_000_000);
    expect(result.buckets[0]!.cost.totalUsd).toBeCloseTo(15 + 75);
    expect(result.totals.attemptsCount).toBe(2);
    expect(result.totals.cost.totalUsd).toBeCloseTo(15 + 75);
  });

  test("buckets are sorted by taskId ascending", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ taskId: "ENG-9", startedAt: "2026-05-20T10:00:00.000Z" }),
      baseRow({ taskId: "ENG-1", startedAt: "2026-05-20T11:00:00.000Z" }),
      baseRow({ taskId: "ENG-3", startedAt: "2026-05-20T12:00:00.000Z" }),
    ];

    const result = rollupWorkItems({ rows, fromInclusive, toExclusive });

    expect(result.buckets.map((bucket) => bucket.taskId)).toEqual([
      "ENG-1",
      "ENG-3",
      "ENG-9",
    ]);
  });

  test("captures first-seen-in-window as the earliest startedAt across the bucket", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({ startedAt: "2026-05-20T14:00:00.000Z", attemptNumber: 2 }),
      baseRow({ startedAt: "2026-05-20T10:00:00.000Z", attemptNumber: 1 }),
      baseRow({ startedAt: "2026-05-21T09:00:00.000Z", attemptNumber: 3 }),
    ];

    const result = rollupWorkItems({ rows, fromInclusive, toExclusive });

    expect(result.buckets[0]!.firstSeenInWindow).toBe("2026-05-20T10:00:00.000Z");
    expect(result.buckets[0]!.lastStartedAt).toBe("2026-05-21T09:00:00.000Z");
  });

  test("computes per-target latest status independently from ticket-wide status", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({
        target: "repo-a",
        status: "completed",
        startedAt: "2026-05-20T10:00:00.000Z",
        attemptNumber: 1,
      }),
      baseRow({
        target: "repo-a",
        status: "failed",
        startedAt: "2026-05-20T11:00:00.000Z",
        attemptNumber: 2,
      }),
      baseRow({
        target: "repo-b",
        status: "completed",
        startedAt: "2026-05-20T12:00:00.000Z",
        attemptNumber: 1,
      }),
    ];

    const result = rollupWorkItems({ rows, fromInclusive, toExclusive });

    expect(result.buckets[0]!.targets).toEqual(["repo-a", "repo-b"]);
    expect(result.buckets[0]!.perTargetLatestStatus).toEqual([
      { target: "repo-a", status: "failed" },
      { target: "repo-b", status: "completed" },
    ]);
    expect(result.buckets[0]!.effectiveStatus).toBe<AttemptStatus>("failed");
  });

  test("tolerates attempt_number collisions across jobs without ambiguous status", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({
        status: "failed",
        startedAt: "2026-05-20T10:00:00.000Z",
        attemptNumber: 1,
      }),
      baseRow({
        status: "completed",
        startedAt: "2026-05-20T15:00:00.000Z",
        attemptNumber: 1,
      }),
    ];

    const result = rollupWorkItems({ rows, fromInclusive, toExclusive });

    expect(result.buckets[0]!.effectiveStatus).toBe<AttemptStatus>("failed");
  });

  // A bucket can span multiple runner/model triples (e.g. an opus execution
  // followed by a sonnet review pass). The cost rollup estimates per row
  // before summing so each row's own rate applies; a refactor to
  // "sum-tokens-then-estimate-once" would silently misprice mixed buckets
  // while every single-rate test stays green.
  test("prices a single bucket spanning two models at per-row rates", () => {
    const rows: AttemptWorkItemRow[] = [
      baseRow({
        runnerName: "claude",
        runnerModel: "claude-opus-4-7",
        startedAt: "2026-05-20T10:00:00.000Z",
        attemptNumber: 1,
        tokensUsed: { inputTokens: 1_000_000, outputTokens: 0 },
      }),
      baseRow({
        runnerName: "claude",
        runnerModel: "claude-sonnet-4-6",
        startedAt: "2026-05-20T11:00:00.000Z",
        attemptNumber: 2,
        tokensUsed: { inputTokens: 1_000_000, outputTokens: 0 },
      }),
    ];

    const result = rollupWorkItems({ rows, fromInclusive, toExclusive });

    expect(result.buckets).toHaveLength(1);
    // 1M opus input @ $15/Mtok + 1M sonnet input @ $3/Mtok = $18.
    // A sum-then-estimate refactor would either bill all 2M at $15 ($30) or
    // at $3 ($6) depending on which row's rate it sampled — the assert below
    // catches either.
    expect(result.buckets[0]!.cost.totalUsd).toBeCloseTo(15 + 3);
    expect(result.buckets[0]!.cost.breakdown.input).toBeCloseTo(15 + 3);
    expect(result.totals.cost.totalUsd).toBeCloseTo(15 + 3);
  });
});
