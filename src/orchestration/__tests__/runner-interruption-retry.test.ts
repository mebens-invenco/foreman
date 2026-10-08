import { describe, expect, test } from "vitest";

import { planRunnerInterruptionRetry, runnerInterruptionWorkFingerprint } from "../runner-interruption-retry.js";

describe("planRunnerInterruptionRetry", () => {
  const interruption = { summary: "Runner provider returned retryable HTTP 503." };

  test.each([
    [1, "2026-09-02T02:00:30.000Z"],
    [2, "2026-09-02T02:01:00.000Z"],
  ])("backs off attempt %i", (attemptNumber, nextEligibleAt) => {
    expect(
      planRunnerInterruptionRetry({ interruption, attemptNumber, finishedAt: "2026-09-02T02:00:00.000Z" }),
    ).toEqual({
      summary: expect.stringContaining(`Retrying attempt ${attemptNumber + 1} of 3 at ${nextEligibleAt}.`),
      nextEligibleAt,
    });
  });

  test("stops after three total attempts", () => {
    expect(planRunnerInterruptionRetry({ interruption, attemptNumber: 3, finishedAt: "2026-09-02T02:00:00.000Z" })).toEqual({
      summary: "Runner provider returned retryable HTTP 503. Automatic retry limit reached after 3 attempts.",
      nextEligibleAt: null,
    });
  });
});

describe("runnerInterruptionWorkFingerprint", () => {
  test("ignores interruption state and pull request recovery attempt counts", () => {
    const context = {
      reviewContext: { headSha: "head-a" },
      pullRequestRecovery: { fingerprint: "pr-a", attempts: 1 },
      runnerInterruption: { taskStateBeforeExecution: "ready" },
    };

    expect(runnerInterruptionWorkFingerprint("execution", context)).toBe(
      runnerInterruptionWorkFingerprint("execution", {
        ...context,
        pullRequestRecovery: { fingerprint: "pr-a", attempts: 3 },
        runnerInterruption: { retriesExhausted: true },
      }),
    );
    expect(runnerInterruptionWorkFingerprint("execution", context)).not.toBe(
      runnerInterruptionWorkFingerprint("execution", { ...context, reviewContext: { headSha: "head-b" } }),
    );
  });
});
