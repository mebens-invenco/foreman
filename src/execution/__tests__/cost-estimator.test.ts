import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { estimateCost, resetUnknownRateWarnings } from "../cost/cost-estimator.js";
import { lookupRunnerRate } from "../cost/rates.js";

describe("estimateCost", () => {
  beforeEach(() => {
    resetUnknownRateWarnings();
  });

  describe("known model", () => {
    test("computes per-bucket USD using the rate table for Claude Fable 5", () => {
      const rate = lookupRunnerRate({
        runnerName: "claude",
        runnerModel: "claude-fable-5",
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
        "claude-fable-5",
      );

      // Per-1M token rates for Fable 5 - fresh in, output, cache read, cache write.
      expect(result.breakdown.input).toBeCloseTo(10);
      expect(result.breakdown.output).toBeCloseTo(50);
      expect(result.breakdown.cacheRead).toBeCloseTo(1);
      expect(result.breakdown.cacheCreate).toBeCloseTo(12.5);
      // Reasoning tokens bill at the output rate.
      expect(result.breakdown.reasoning).toBeCloseTo(50);
      expect(result.totalUsd).toBeCloseTo(10 + 50 + 1 + 12.5 + 50);
    });

    test("computes per-bucket USD using the rate table for Claude Opus 4.7", () => {
      const rate = lookupRunnerRate({
        runnerName: "claude",
        runnerModel: "claude-opus-4-7",
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
      );

      // Per-1M token rates for Opus 4.7 — fresh in, output, cache read, cache write.
      expect(result.breakdown.input).toBeCloseTo(5);
      expect(result.breakdown.output).toBeCloseTo(25);
      expect(result.breakdown.cacheRead).toBeCloseTo(0.5);
      expect(result.breakdown.cacheCreate).toBeCloseTo(6.25);
      // Reasoning tokens bill at the output rate.
      expect(result.breakdown.reasoning).toBeCloseTo(25);
      expect(result.totalUsd).toBeCloseTo(5 + 25 + 0.5 + 6.25 + 25);
    });

    test("computes per-bucket USD using the rate table for Claude Opus 4.8", () => {
      const rate = lookupRunnerRate({
        runnerName: "claude",
        runnerModel: "claude-opus-4-8",
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
        "claude-opus-4-8",
      );

      // Per-1M token rates for Opus 4.8 — fresh in, output, cache read, cache write.
      expect(result.breakdown.input).toBeCloseTo(5);
      expect(result.breakdown.output).toBeCloseTo(25);
      expect(result.breakdown.cacheRead).toBeCloseTo(0.5);
      expect(result.breakdown.cacheCreate).toBeCloseTo(6.25);
      // Reasoning tokens bill at the output rate.
      expect(result.breakdown.reasoning).toBeCloseTo(25);
      expect(result.totalUsd).toBeCloseTo(5 + 25 + 0.5 + 6.25 + 25);
    });

    test("matches current Opus 4.7 pricing at production-scale usage", () => {
      const result = estimateCost(
        {
          inputTokens: 1_200,
          outputTokens: 661_000,
          cacheReadInputTokens: 180_000_000,
          cacheCreationInputTokens: 5_200_000,
        },
        "claude",
        "claude-opus-4-7",
      );

      expect(result.totalUsd).toBeGreaterThan(100);
      expect(result.totalUsd).toBeLessThan(200);
    });

    test("matches a Claude attempt regardless of persisted runnerVariant (effort)", () => {
      // Regression guard: attempts persist `runnerVariant` as the configured
      // effort ("high"/"max"/etc.), not "default". Pricing is model-level, so
      // the lookup must succeed for the real default-config row.
      const tokens = { inputTokens: 1_000_000, outputTokens: 0 };
      const withHigh = estimateCost(tokens, "claude", "claude-opus-4-7");
      expect(withHigh.totalUsd).toBeCloseTo(5);
    });

    test("matches the OpenCode default-config model (openai/gpt-5.5)", () => {
      const result = estimateCost(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        "opencode",
        "openai/gpt-5.5",
      );
      expect(result.totalUsd).toBeGreaterThan(0);
    });

    test.each`
      runnerName    | runnerModel                     | input   | output | cacheRead | cacheCreate
      ${"claude"}  | ${"claude-fable-5-1"}          | ${10}   | ${50}  | ${0.25}   | ${12.5}
      ${"claude"}  | ${"claude-opus-5"}             | ${5}    | ${25}  | ${0.5}    | ${6.25}
      ${"codex"}   | ${"gpt-5.5"}                   | ${5}    | ${30}  | ${0.5}    | ${0}
      ${"codex"}   | ${"gpt-5.6-sol"}               | ${4}    | ${20}  | ${0.4}    | ${5}
      ${"codex"}   | ${"gpt-5.6-terra"}             | ${2}    | ${12}  | ${0.2}    | ${2.5}
      ${"codex"}   | ${"gpt-5.6-luna"}              | ${0.2}  | ${1.2} | ${0.02}   | ${0.25}
      ${"opencode"} | ${"openai/gpt-5.5"}           | ${5}    | ${30}  | ${0.5}    | ${0}
      ${"opencode"} | ${"openai/gpt-5.3-codex"}     | ${1.75} | ${14}  | ${0.175}  | ${0}
      ${"opencode"} | ${"openai/gpt-5.4"}           | ${2.5}  | ${15}  | ${0.25}   | ${0}
      ${"opencode"} | ${"openai/gpt-5.6-sol"}       | ${4}    | ${20}  | ${0.4}    | ${5}
      ${"opencode"} | ${"openai/gpt-5.6-sol-fast"}  | ${8}    | ${40}  | ${0.8}    | ${10}
      ${"opencode"} | ${"openai/gpt-6-astra"}       | ${10}   | ${50}  | ${1}      | ${12.5}
      ${"opencode"} | ${"openai/gpt-6-astra-fast"}  | ${20}   | ${100} | ${2}      | ${25}
    `(
      "computes all token buckets for $runnerName/$runnerModel",
      ({ runnerName, runnerModel, input, output, cacheRead, cacheCreate }) => {
        const result = estimateCost(
          {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadInputTokens: 1_000_000,
            cacheCreationInputTokens: 1_000_000,
            reasoningOutputTokens: 1_000_000,
          },
          runnerName,
          runnerModel,
        );

        expect(result.breakdown).toEqual({
          input,
          output,
          cacheRead,
          cacheCreate,
          reasoning: output,
        });
        expect(result.totalUsd).toBeCloseTo(
          input + output + cacheRead + cacheCreate + output,
        );
      },
    );
  });

  describe("unknown model", () => {
    test("returns zero cost and warns once per process", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const first = estimateCost(
        { inputTokens: 100, outputTokens: 100 },
        "claude",
        "claude-experimental-x",
      );
      const second = estimateCost(
        { inputTokens: 100, outputTokens: 100 },
        "claude",
        "claude-experimental-x",
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
      );

      expect(result.breakdown.cacheRead).toBe(0);
      expect(result.breakdown.cacheCreate).toBe(0);
      expect(result.breakdown.reasoning).toBe(0);
      expect(result.totalUsd).toBeCloseTo(5 + 25);
    });
  });

  describe("zero usage", () => {
    test("returns zero cost without warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = estimateCost(
        { inputTokens: 0, outputTokens: 0 },
        "claude",
        "claude-opus-4-7",
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
      expect(estimateCost(null, "claude", "claude-opus-4-7").totalUsd).toBe(0);
      expect(estimateCost(undefined, "claude", "claude-opus-4-7").totalUsd).toBe(0);
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
      const result = estimateCost(tokens, "claude", "claude-opus-4-7");

      // Each bucket = 1000 * per-MTok rate.
      expect(result.breakdown.input).toBeCloseTo(5_000);
      expect(result.breakdown.output).toBeCloseTo(25_000);
      expect(result.breakdown.cacheRead).toBeCloseTo(500);
      expect(result.breakdown.cacheCreate).toBeCloseTo(6_250);
      expect(result.totalUsd).toBeCloseTo(5_000 + 25_000 + 500 + 6_250);
    });
  });

  afterEach(() => {
    resetUnknownRateWarnings();
  });
});
