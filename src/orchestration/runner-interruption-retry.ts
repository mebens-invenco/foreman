import type { RetryableRunnerInterruption } from "../execution/index.js";
import { stableStringify } from "../lib/json.js";

const retryDelaysMs = [30_000, 60_000] as const;

export type RunnerInterruptionRetry = {
  summary: string;
  nextEligibleAt: string | null;
};

export const runnerInterruptionWorkFingerprint = (selectionContext: Record<string, unknown>): string => {
  const { runnerInterruption: _runnerInterruption, pullRequestRecovery, ...workContext } = selectionContext;
  const recoveryFingerprint =
    typeof pullRequestRecovery === "object" && pullRequestRecovery !== null && "fingerprint" in pullRequestRecovery
      ? pullRequestRecovery.fingerprint
      : undefined;

  return stableStringify({
    ...workContext,
    ...(recoveryFingerprint === undefined ? {} : { pullRequestRecovery: { fingerprint: recoveryFingerprint } }),
  });
};

export const planRunnerInterruptionRetry = (input: {
  interruption: RetryableRunnerInterruption;
  attemptNumber: number;
  finishedAt: string;
}): RunnerInterruptionRetry => {
  const delayMs = retryDelaysMs[input.attemptNumber - 1];
  if (delayMs === undefined) {
    return {
      summary: `${input.interruption.summary} Automatic retry limit reached after ${input.attemptNumber} attempts.`,
      nextEligibleAt: null,
    };
  }

  const nextEligibleAt = new Date(Date.parse(input.finishedAt) + delayMs).toISOString();
  return {
    summary: `${input.interruption.summary} Retrying attempt ${input.attemptNumber + 1} of ${retryDelaysMs.length + 1} at ${nextEligibleAt}.`,
    nextEligibleAt,
  };
};
