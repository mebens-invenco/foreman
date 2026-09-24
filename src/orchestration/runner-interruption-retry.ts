import {
  actionableReviewThreadFingerprint,
  latestActionableConversationCommentId,
  latestActionableReviewSummaryId,
  type ActionType,
  type ReviewContext,
} from "../domain/index.js";
import type { RetryableRunnerInterruption } from "../execution/index.js";
import { stableStringify } from "../lib/json.js";

const retryDelaysMs = [30_000, 60_000] as const;

export type RunnerInterruptionRetry = {
  summary: string;
  nextEligibleAt: string | null;
};

const reviewWorkFingerprint = (context: ReviewContext): string => stableStringify({
  url: context.pullRequestUrl,
  headSha: context.headSha,
  baseBranch: context.baseBranch,
  reviewSummaryId: latestActionableReviewSummaryId(context),
  conversationCommentId: latestActionableConversationCommentId(context),
  threads: actionableReviewThreadFingerprint(context),
  failingChecks: context.failingChecks.map(stableStringify).sort(),
  conflicting: context.mergeState === "conflicting",
});

export const runnerInterruptionWorkFingerprint = (
  action: ActionType,
  selectionContext: Record<string, unknown>,
): string => {
  const { runnerInterruption: _runnerInterruption, pullRequestRecovery, ...workContext } = selectionContext;
  const reviewContext = selectionContext.reviewContext as ReviewContext | undefined;
  if (reviewContext) {
    if (action === "review") {
      return reviewWorkFingerprint(reviewContext);
    }
    if (action === "reviewer") {
      return stableStringify({
        url: reviewContext.pullRequestUrl,
        headSha: reviewContext.headSha,
        baseBranch: reviewContext.baseBranch,
      });
    }
    if (action === "retry") {
      return stableStringify({
        url: reviewContext.pullRequestUrl,
        headSha: reviewContext.headSha,
        state: reviewContext.state,
      });
    }
  }
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
