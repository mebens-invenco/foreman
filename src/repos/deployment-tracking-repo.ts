export type DeploymentStatus = "succeeded" | "in_progress" | "follow_up_created" | "blocked";

export type DeploymentRecord = {
  id: string;
  taskId: string;
  taskTargetId: string;
  repoKey: string;
  prUrl: string;
  prNumber: number;
  prHeadBranch: string;
  prBaseBranch: string;
  instructionHash: string;
  instructionBody: string;
  latestStatus: DeploymentStatus;
  latestSummary: string;
  nextEligibleAt: string | null;
  retryCount: number;
  blockedRetryCount: number;
  createdFollowUpTaskIds: string[];
  successful: boolean;
  sourceAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface DeploymentTrackingRepo {
  getDeploymentRecord(input: { taskTargetId: string; prUrl: string; instructionHash: string }): DeploymentRecord | null;
  listDeploymentRecordsForTask(taskId: string): DeploymentRecord[];
  upsertDeploymentRecord(input: {
    taskId: string;
    taskTargetId: string;
    repoKey: string;
    prUrl: string;
    prNumber: number;
    prHeadBranch: string;
    prBaseBranch: string;
    instructionHash: string;
    instructionBody: string;
    latestStatus: DeploymentStatus;
    latestSummary: string;
    nextEligibleAt: string | null;
    retryCount: number;
    blockedRetryCount: number;
    createdFollowUpTaskIds: string[];
    successful: boolean;
    sourceAttemptId: string | null;
  }): DeploymentRecord;
}
