import type { ReviewContext } from "../domain/index.js";

export type ReviewCheckpointRecord = {
  id: string;
  taskId: string;
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

export interface ReviewCheckpointRepo {
  getReviewCheckpoint(taskId: string, prUrl: string): ReviewCheckpointRecord | null;
  upsertReviewCheckpoint(input: {
    taskId: string;
    prUrl: string;
    reviewContext: ReviewContext;
    sourceAttemptId: string;
  }): void;
  deleteReviewCheckpoint(taskId: string, prUrl: string): void;
}
