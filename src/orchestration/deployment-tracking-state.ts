import { addSeconds } from "../lib/time.js";
import type { WorkspaceConfig } from "../workspace/config.js";

export type DeploymentSelectionContext = {
  instructionHash: string;
  instructionBody: string;
  pullRequest: { url: string; number: number; headBranch: string; baseBranch: string };
};

export const readDeploymentSelectionContext = (selectionContext: Record<string, unknown>): DeploymentSelectionContext | null => {
  const deployment = selectionContext.deployment;
  const pullRequest = selectionContext.pullRequestReference;
  if (!deployment || typeof deployment !== "object" || !pullRequest || typeof pullRequest !== "object") {
    return null;
  }

  const deploymentRecord = deployment as Record<string, unknown>;
  const pullRequestRecord = pullRequest as Record<string, unknown>;
  if (
    typeof deploymentRecord.instructionHash !== "string" ||
    typeof deploymentRecord.instructionBody !== "string" ||
    typeof pullRequestRecord.url !== "string" ||
    typeof pullRequestRecord.number !== "number" ||
    typeof pullRequestRecord.headBranch !== "string" ||
    typeof pullRequestRecord.baseBranch !== "string"
  ) {
    return null;
  }

  return {
    instructionHash: deploymentRecord.instructionHash,
    instructionBody: deploymentRecord.instructionBody,
    pullRequest: {
      url: pullRequestRecord.url,
      number: pullRequestRecord.number,
      headBranch: pullRequestRecord.headBranch,
      baseBranch: pullRequestRecord.baseBranch,
    },
  };
};

export const nextDeploymentRetryEligibleAt = (
  config: WorkspaceConfig["deployment"],
  retryCount: number,
  now: Date = new Date(),
): string => {
  const multiplier = 2 ** Math.max(0, retryCount - 1);
  const intervalMinutes = Math.min(config.maxRetryIntervalMinutes, config.minRetryIntervalMinutes * multiplier);
  return addSeconds(now, intervalMinutes * 60);
};
