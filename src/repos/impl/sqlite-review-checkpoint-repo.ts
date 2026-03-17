import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import { newId } from "../../lib/ids.js";
import type { ReviewContext } from "../../domain/index.js";
import type { ReviewCheckpointRecord, ReviewCheckpointRepo } from "../review-checkpoint-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const mapReviewCheckpoint = (row: SqliteRow): ReviewCheckpointRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  prUrl: String(row.pr_url),
  headSha: String(row.head_sha),
  latestReviewSummaryId: (row.latest_review_summary_id as string | null) ?? null,
  latestConversationCommentId: (row.latest_conversation_comment_id as string | null) ?? null,
  checksFingerprint: String(row.checks_fingerprint),
  mergeState: row.merge_state as ReviewContext["mergeState"],
  recordedAt: String(row.recorded_at),
  sourceAttemptId: String(row.source_attempt_id),
});

export class SqliteReviewCheckpointRepo implements ReviewCheckpointRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  getReviewCheckpoint(taskId: string, prUrl: string): ReviewCheckpointRecord | null {
    const row = this.sqlite
      .prepare(
        "SELECT id, task_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id, checks_fingerprint, merge_state, recorded_at, source_attempt_id FROM review_checkpoint WHERE task_id = ? AND pr_url = ?",
      )
      .get(taskId, prUrl) as SqliteRow | undefined;
    return row ? mapReviewCheckpoint(row) : null;
  }

  upsertReviewCheckpoint(input: {
    taskId: string;
    prUrl: string;
    reviewContext: ReviewContext;
    sourceAttemptId: string;
  }): void {
    const checksFingerprint = stableStringify({
      failing: input.reviewContext.failingChecks,
      pending: input.reviewContext.pendingChecks,
    });
    const latestReviewSummaryId = input.reviewContext.actionableReviewSummaries.at(-1)?.id ?? null;
    const latestConversationCommentId = input.reviewContext.actionableConversationComments.at(-1)?.id ?? null;
    this.sqlite
      .prepare(
        `INSERT INTO review_checkpoint(
          id, task_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id,
          checks_fingerprint, merge_state, recorded_at, source_attempt_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, pr_url) DO UPDATE SET
          head_sha = excluded.head_sha,
          latest_review_summary_id = excluded.latest_review_summary_id,
          latest_conversation_comment_id = excluded.latest_conversation_comment_id,
          checks_fingerprint = excluded.checks_fingerprint,
          merge_state = excluded.merge_state,
          recorded_at = excluded.recorded_at,
          source_attempt_id = excluded.source_attempt_id`,
      )
      .run(
        newId(),
        input.taskId,
        input.prUrl,
        input.reviewContext.headSha,
        latestReviewSummaryId,
        latestConversationCommentId,
        checksFingerprint,
        input.reviewContext.mergeState,
        isoNow(),
        input.sourceAttemptId,
      );
  }

  deleteReviewCheckpoint(taskId: string, prUrl: string): void {
    this.sqlite.prepare("DELETE FROM review_checkpoint WHERE task_id = ? AND pr_url = ?").run(taskId, prUrl);
  }
}
