import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import { newId } from "../../lib/ids.js";
import {
  actionableReviewThreadFingerprint,
  latestActionableConversationCommentId,
  latestActionableReviewSummaryId,
  type ReviewContext,
} from "../../domain/index.js";
import type { ReviewCheckpointRecord, ReviewCheckpointRepo } from "../review-checkpoint-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const mapReviewCheckpoint = (row: SqliteRow): ReviewCheckpointRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  taskTargetId: String(row.task_target_id),
  prUrl: String(row.pr_url),
  headSha: String(row.head_sha),
  latestReviewSummaryId: (row.latest_review_summary_id as string | null) ?? null,
  latestConversationCommentId: (row.latest_conversation_comment_id as string | null) ?? null,
  reviewThreadsFingerprint: String(row.review_threads_fingerprint),
  checksFingerprint: String(row.checks_fingerprint),
  mergeState: row.merge_state as ReviewContext["mergeState"],
  recordedAt: String(row.recorded_at),
  sourceAttemptId: String(row.source_attempt_id),
});

export class SqliteReviewCheckpointRepo implements ReviewCheckpointRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  getReviewCheckpoint(taskTargetId: string): ReviewCheckpointRecord | null {
    const row = this.sqlite
      .prepare(
        "SELECT id, task_id, task_target_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id, review_threads_fingerprint, checks_fingerprint, merge_state, recorded_at, source_attempt_id FROM review_checkpoint WHERE task_target_id = ?",
      )
      .get(taskTargetId) as SqliteRow | undefined;
    return row ? mapReviewCheckpoint(row) : null;
  }

  upsertReviewCheckpoint(input: {
    taskId: string;
    taskTargetId: string;
    prUrl: string;
    reviewContext: ReviewContext;
    sourceAttemptId: string;
  }): void {
    const checksFingerprint = stableStringify({
      failing: input.reviewContext.failingChecks,
      pending: input.reviewContext.pendingChecks,
    });
    const latestReviewSummaryId = latestActionableReviewSummaryId(input.reviewContext);
    const latestConversationCommentId = latestActionableConversationCommentId(input.reviewContext);
    const reviewThreadsFingerprint = actionableReviewThreadFingerprint(input.reviewContext);
    this.sqlite
      .prepare(
        `INSERT INTO review_checkpoint(
          id, task_id, task_target_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id,
          review_threads_fingerprint, checks_fingerprint, merge_state, recorded_at, source_attempt_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_target_id) DO UPDATE SET
          task_id = excluded.task_id,
          head_sha = excluded.head_sha,
          pr_url = excluded.pr_url,
          latest_review_summary_id = excluded.latest_review_summary_id,
          latest_conversation_comment_id = excluded.latest_conversation_comment_id,
          review_threads_fingerprint = excluded.review_threads_fingerprint,
          checks_fingerprint = excluded.checks_fingerprint,
          merge_state = excluded.merge_state,
          recorded_at = excluded.recorded_at,
          source_attempt_id = excluded.source_attempt_id`,
      )
      .run(
        newId(),
        input.taskId,
        input.taskTargetId,
        input.prUrl,
        input.reviewContext.headSha,
        latestReviewSummaryId,
        latestConversationCommentId,
        reviewThreadsFingerprint,
        checksFingerprint,
        input.reviewContext.mergeState,
        isoNow(),
        input.sourceAttemptId,
      );
  }

  deleteReviewCheckpoint(taskTargetId: string): void {
    this.sqlite.prepare("DELETE FROM review_checkpoint WHERE task_target_id = ?").run(taskTargetId);
  }
}
