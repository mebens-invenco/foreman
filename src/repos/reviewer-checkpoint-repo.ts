import type { ReviewContext } from "../domain/index.js";

export type ReviewerCheckpointRecord = {
  id: string;
  taskId: string;
  taskTargetId: string;
  prUrl: string;
  headSha: string;
  latestReviewSummaryId: string | null;
  latestConversationCommentId: string | null;
  reviewThreadsFingerprint: string;
  checksFingerprint: string;
  mergeState: ReviewContext["mergeState"];
  recordedAt: string;
  sourceAttemptId: string;
};

export interface ReviewerCheckpointRepo {
  getReviewerCheckpoint(taskTargetId: string): ReviewerCheckpointRecord | null;
  upsertReviewerCheckpoint(input: {
    taskId: string;
    taskTargetId: string;
    prUrl: string;
    reviewContext: ReviewContext;
    sourceAttemptId: string;
  }): void;
  deleteReviewerCheckpoint(taskTargetId: string): void;
}
