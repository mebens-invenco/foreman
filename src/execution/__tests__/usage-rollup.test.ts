import { describe, expect, test } from "vitest";

import { resolveUsageRange } from "../cost/usage-range.js";
import { rollupUsage } from "../cost/usage-rollup.js";

const opusRow = (overrides: {
  startedAt: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}) => ({
  runnerName: "claude" as const,
  runnerModel: "claude-opus-4-7",
  runnerVariant: "default",
  startedAt: overrides.startedAt,
  tokensUsed: {
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheReadInputTokens: overrides.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: overrides.cacheCreationInputTokens ?? 0,
  },
});

const sonnetRow = (overrides: { startedAt: string; outputTokens?: number }) => ({
  runnerName: "claude" as const,
  runnerModel: "claude-sonnet-4-6",
  runnerVariant: "default",
  startedAt: overrides.startedAt,
  tokensUsed: {
    inputTokens: 0,
    outputTokens: overrides.outputTokens ?? 0,
  },
});

describe("rollupUsage", () => {
  test("groups by day and sums per-day attempts, tokens and cost", () => {
    const rollup = rollupUsage({
      rows: [
        opusRow({ startedAt: "2026-05-20T10:00:00Z", inputTokens: 1_000_000 }),
        opusRow({ startedAt: "2026-05-20T22:00:00Z", outputTokens: 1_000_000 }),
        opusRow({ startedAt: "2026-05-21T01:00:00Z", cacheReadInputTokens: 1_000_000 }),
      ],
      groupBy: "day",
      fromInclusive: "2026-05-20T00:00:00Z",
      toExclusive: "2026-05-22T00:00:00Z",
    });

    expect(rollup.buckets).toHaveLength(2);
    const [day20, day21] = rollup.buckets;
    expect(day20!.groupKey).toBe("2026-05-20");
    expect(day20!.attemptsCount).toBe(2);
    expect(day20!.cost.totalUsd).toBeCloseTo(15 + 75);
    expect(day21!.groupKey).toBe("2026-05-21");
    expect(day21!.attemptsCount).toBe(1);
    expect(day21!.cost.totalUsd).toBeCloseTo(1.5);

    expect(rollup.totals.attemptsCount).toBe(3);
    expect(rollup.totals.cost.totalUsd).toBeCloseTo(15 + 75 + 1.5);
  });

  test("groups by runner+model and uses the matching rate per row", () => {
    const rollup = rollupUsage({
      rows: [
        opusRow({ startedAt: "2026-05-20T10:00:00Z", outputTokens: 1_000_000 }),
        sonnetRow({ startedAt: "2026-05-20T11:00:00Z", outputTokens: 1_000_000 }),
      ],
      groupBy: "model",
      fromInclusive: "2026-05-20T00:00:00Z",
      toExclusive: "2026-05-21T00:00:00Z",
    });

    expect(rollup.buckets.map((bucket) => bucket.groupKey)).toEqual([
      "claude/claude-opus-4-7",
      "claude/claude-sonnet-4-6",
    ]);
    expect(rollup.buckets[0]!.cost.totalUsd).toBeCloseTo(75);
    expect(rollup.buckets[1]!.cost.totalUsd).toBeCloseTo(15);
  });

  test("tolerates null tokens (attempts that never produced usage)", () => {
    const rollup = rollupUsage({
      rows: [
        {
          runnerName: "claude",
          runnerModel: "claude-opus-4-7",
          runnerVariant: "default",
          startedAt: "2026-05-20T10:00:00Z",
          tokensUsed: null,
        },
      ],
      groupBy: "day",
      fromInclusive: "2026-05-20T00:00:00Z",
      toExclusive: "2026-05-21T00:00:00Z",
    });

    expect(rollup.buckets[0]!.attemptsCount).toBe(1);
    expect(rollup.buckets[0]!.cost.totalUsd).toBe(0);
    expect(rollup.totals.attemptsCount).toBe(1);
  });
});

describe("resolveUsageRange", () => {
  test("defaults to the last 7 full days ending today UTC", () => {
    const range = resolveUsageRange({ now: new Date("2026-05-26T12:34:56Z") });
    expect(range.fromDate).toBe("2026-05-20");
    expect(range.toDate).toBe("2026-05-26");
    expect(range.fromInclusive).toBe("2026-05-20T00:00:00.000Z");
    expect(range.toExclusive).toBe("2026-05-27T00:00:00.000Z");
  });

  test("makes the upper bound exclusive at midnight of the day after `to`", () => {
    const range = resolveUsageRange({ from: "2026-05-20", to: "2026-05-26" });
    expect(range.fromInclusive).toBe("2026-05-20T00:00:00.000Z");
    expect(range.toExclusive).toBe("2026-05-27T00:00:00.000Z");
  });

  test("rejects inverted ranges", () => {
    expect(() => resolveUsageRange({ from: "2026-05-26", to: "2026-05-20" })).toThrow(/must be on or before/);
  });

  test("rejects malformed dates", () => {
    expect(() => resolveUsageRange({ from: "2026-5-1" })).toThrow(/YYYY-MM-DD/);
  });
});
