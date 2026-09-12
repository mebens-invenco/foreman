import type { RetryableRunnerInterruption } from "../execution/index.js";

const retryDelaysMs = [30_000, 60_000] as const;

export type RunnerInterruptionRetry = {
  summary: string;
  nextEligibleAt: string | null;
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
