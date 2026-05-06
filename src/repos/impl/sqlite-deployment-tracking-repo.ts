import { newId } from "../../lib/ids.js";
import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import type { DeploymentRecord, DeploymentStatus, DeploymentTrackingRepo } from "../deployment-tracking-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const mapDeploymentRecord = (row: SqliteRow): DeploymentRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  taskTargetId: String(row.task_target_id),
  repoKey: String(row.repo_key),
  prUrl: String(row.pr_url),
  prNumber: Number(row.pr_number),
  prHeadBranch: String(row.pr_head_branch),
  prBaseBranch: String(row.pr_base_branch),
  instructionHash: String(row.instruction_hash),
  instructionBody: String(row.instruction_body),
  latestStatus: row.latest_status as DeploymentStatus,
  latestSummary: String(row.latest_summary ?? ""),
  nextEligibleAt: (row.next_eligible_at as string | null) ?? null,
  blockedRetryCount: Number(row.blocked_retry_count ?? 0),
  createdFollowUpTaskIds: JSON.parse(String(row.created_follow_up_task_ids_json ?? "[]")),
  successful: Number(row.successful) === 1,
  sourceAttemptId: (row.source_attempt_id as string | null) ?? null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class SqliteDeploymentTrackingRepo implements DeploymentTrackingRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  getDeploymentRecord(input: { taskTargetId: string; prUrl: string; instructionHash: string }): DeploymentRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, task_id, task_target_id, repo_key, pr_url, pr_number, pr_head_branch, pr_base_branch,
                instruction_hash, instruction_body, latest_status, latest_summary, next_eligible_at,
                blocked_retry_count, created_follow_up_task_ids_json, successful, source_attempt_id,
                created_at, updated_at
           FROM deployment_tracking
          WHERE task_target_id = ?
            AND pr_url = ?
            AND instruction_hash = ?
          LIMIT 1`,
      )
      .get(input.taskTargetId, input.prUrl, input.instructionHash) as SqliteRow | undefined;

    return row ? mapDeploymentRecord(row) : null;
  }

  listDeploymentRecordsForTask(taskId: string): DeploymentRecord[] {
    return this.sqlite
      .prepare(
        `SELECT id, task_id, task_target_id, repo_key, pr_url, pr_number, pr_head_branch, pr_base_branch,
                instruction_hash, instruction_body, latest_status, latest_summary, next_eligible_at,
                blocked_retry_count, created_follow_up_task_ids_json, successful, source_attempt_id,
                created_at, updated_at
           FROM deployment_tracking
          WHERE task_id = ?
          ORDER BY repo_key ASC, updated_at DESC`,
      )
      .all(taskId)
      .map((row) => mapDeploymentRecord(row as SqliteRow));
  }

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
    blockedRetryCount: number;
    createdFollowUpTaskIds: string[];
    successful: boolean;
    sourceAttemptId: string | null;
  }): DeploymentRecord {
    const id = newId();
    const now = isoNow();
    this.sqlite
      .prepare(
        `INSERT INTO deployment_tracking(
          id, task_id, task_target_id, repo_key, pr_url, pr_number, pr_head_branch, pr_base_branch,
          instruction_hash, instruction_body, latest_status, latest_summary, next_eligible_at,
          blocked_retry_count, created_follow_up_task_ids_json, successful, source_attempt_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_target_id, pr_url, instruction_hash) DO UPDATE SET
          task_id = excluded.task_id,
          repo_key = excluded.repo_key,
          pr_number = excluded.pr_number,
          pr_head_branch = excluded.pr_head_branch,
          pr_base_branch = excluded.pr_base_branch,
          instruction_body = excluded.instruction_body,
          latest_status = excluded.latest_status,
          latest_summary = excluded.latest_summary,
          next_eligible_at = excluded.next_eligible_at,
          blocked_retry_count = excluded.blocked_retry_count,
          created_follow_up_task_ids_json = excluded.created_follow_up_task_ids_json,
          successful = excluded.successful,
          source_attempt_id = excluded.source_attempt_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.taskId,
        input.taskTargetId,
        input.repoKey,
        input.prUrl,
        input.prNumber,
        input.prHeadBranch,
        input.prBaseBranch,
        input.instructionHash,
        input.instructionBody,
        input.latestStatus,
        input.latestSummary,
        input.nextEligibleAt,
        input.blockedRetryCount,
        stableStringify(input.createdFollowUpTaskIds),
        input.successful ? 1 : 0,
        input.sourceAttemptId,
        now,
        now,
      );

    return this.getDeploymentRecord({ taskTargetId: input.taskTargetId, prUrl: input.prUrl, instructionHash: input.instructionHash })!;
  }
}
