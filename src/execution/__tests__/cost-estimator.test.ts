import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { estimateCost, resetUnknownRateWarnings } from "../cost/cost-estimator.js";
import { lookupRunnerRate } from "../cost/rates.js";

describe("estimateCost", () => {
  beforeEach(() => {
    resetUnknownRateWarnings();
  });

  describe("known model", () => {
    test("computes per-bucket USD using the rate table for Claude Opus 4.7", () => {
      const rate = lookupRunnerRate({
        runnerName: "claude",
        runnerModel: "claude-opus-4-7",
        runnerVariant: "default",
      });
      expect(rate).not.toBeNull();

      const result = estimateCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadInputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
          reasoningOutputTokens: 1_000_000,
        },
        "claude",
        "claude-opus-4-7",
        "default",
      );

      // Per-1M token rates for Opus 4.7 — fresh in, output, cache read, cache write.
      expect(result.breakdown.input).toBeCloseTo(15);
      expect(result.breakdown.output).toBeCloseTo(75);
      expect(result.breakdown.cacheRead).toBeCloseTo(1.5);
      expect(result.breakdown.cacheCreate).toBeCloseTo(18.75);
      // Reasoning tokens bill at the output rate.
      expect(result.breakdown.reasoning).toBeCloseTo(75);
      expect(result.totalUsd).toBeCloseTo(15 + 75 + 1.5 + 18.75 + 75);
    });

    test("matches the 2026-05-26 audit ballpark for a foreman day on Opus 4.7", () => {
      const result = estimateCost(
        {
          inputTokens: 1_200,
          outputTokens: 661_000,
          cacheReadInputTokens: 180_000_000,
          cacheCreationInputTokens: 5_200_000,
        },
        "claude",
        "claude-opus-4-7",
        "default",
      );

      // Sanity range — at Opus 4.7 rates and these token counts the day
      // should land within roughly +/- $100 of the audit number. Anchor
      // the rate-table to the audit so a future bad rate edit fails here.
      expect(result.totalUsd).toBeGreaterThan(300);
      expect(result.totalUsd).toBeLessThan(500);
    });
  });

  describe("unknown model", () => {
    test("returns zero cost and warns once per process", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const first = estimateCost(
        { inputTokens: 100, outputTokens: 100 },
        "claude",
        "claude-experimental-x",
        "default",
      );
      const second = estimateCost(
        { inputTokens: 100, outputTokens: 100 },
        "claude",
        "claude-experimental-x",
        "default",
      );

      expect(first.totalUsd).toBe(0);
      expect(second.totalUsd).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockRestore();
    });
  });

  describe("missing optional buckets", () => {
    test("treats absent cache/reasoning fields as zero", () => {
      const result = estimateCost(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        "claude",
        "claude-opus-4-7",
        "default",
      );

      expect(result.breakdown.cacheRead).toBe(0);
      expect(result.breakdown.cacheCreate).toBe(0);
      expect(result.breakdown.reasoning).toBe(0);
      expect(result.totalUsd).toBeCloseTo(15 + 75);
    });
  });

  describe("zero usage", () => {
    test("returns zero cost without warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = estimateCost(
        { inputTokens: 0, outputTokens: 0 },
        "claude",
        "claude-opus-4-7",
        "default",
      );

      expect(result.totalUsd).toBe(0);
      expect(result.breakdown).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        reasoning: 0,
      });
      expect(warn).not.toHaveBeenCalled();

      warn.mockRestore();
    });

    test("returns zero when tokens are null/undefined", () => {
      expect(estimateCost(null, "claude", "claude-opus-4-7", "default").totalUsd).toBe(0);
      expect(estimateCost(undefined, "claude", "claude-opus-4-7", "default").totalUsd).toBe(0);
    });
  });

  describe("large usage", () => {
    test("scales linearly without cent-level precision loss", () => {
      const tokens = {
        inputTokens: 1_000_000_000,
        outputTokens: 1_000_000_000,
        cacheReadInputTokens: 1_000_000_000,
        cacheCreationInputTokens: 1_000_000_000,
      };
      const result = estimateCost(tokens, "claude", "claude-opus-4-7", "default");

      // Each bucket = 1000 * per-MTok rate.
      expect(result.breakdown.input).toBeCloseTo(15_000);
      expect(result.breakdown.output).toBeCloseTo(75_000);
      expect(result.breakdown.cacheRead).toBeCloseTo(1_500);
      expect(result.breakdown.cacheCreate).toBeCloseTo(18_750);
      expect(result.totalUsd).toBeCloseTo(15_000 + 75_000 + 1_500 + 18_750);
    });
  });

  afterEach(() => {
    resetUnknownRateWarnings();
  });
});
