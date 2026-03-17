import type { ReviewContext } from "../domain/index.js";
import type { ReviewCheckpointRecord } from "./records.js";

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
