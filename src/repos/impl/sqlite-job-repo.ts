import { ForemanError } from "../../lib/errors.js";
import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import { newId } from "../../lib/ids.js";
import type { JobRepo } from "../job-repo.js";
import type { JobRecord } from "../records.js";
import type { ActionType, JobStatus } from "../../domain/index.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const mapJob = (row: SqliteRow): JobRecord => ({
  id: String(row.id),
  taskId: String(row.task_id),
  taskProvider: row.task_provider as JobRecord["taskProvider"],
  action: row.action as ActionType,
  status: row.status as JobStatus,
  priorityRank: Number(row.priority_rank),
  repoKey: String(row.repo_key),
  baseBranch: (row.base_branch as string | null) ?? null,
  dedupeKey: String(row.dedupe_key),
  selectionReason: String(row.selection_reason),
  selectionContext: JSON.parse(String(row.selection_context_json ?? "{}")),
  scoutRunId: (row.scout_run_id as string | null) ?? null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  leasedAt: (row.leased_at as string | null) ?? null,
  startedAt: (row.started_at as string | null) ?? null,
  finishedAt: (row.finished_at as string | null) ?? null,
  errorMessage: (row.error_message as string | null) ?? null,
});

export class SqliteJobRepo implements JobRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  activeJobCount(): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM job WHERE status IN ('queued', 'leased', 'running')")
      .get() as SqliteRow;
    return Number(row.count ?? 0);
  }

  hasActiveDedupeKey(dedupeKey: string): boolean {
    const row = this.sqlite
      .prepare("SELECT 1 AS present FROM job WHERE dedupe_key = ? AND status IN ('queued', 'leased', 'running') LIMIT 1")
      .get(dedupeKey) as SqliteRow | undefined;
    return row !== undefined;
  }

  createJob(input: {
    taskId: string;
    taskProvider: "linear" | "file";
    action: ActionType;
    priorityRank: number;
    repoKey: string;
    baseBranch?: string | null;
    dedupeKey: string;
    selectionReason: string;
    selectionContext?: Record<string, unknown>;
    scoutRunId?: string | null;
  }): JobRecord {
    const id = newId();
    const now = isoNow();
    this.sqlite
      .prepare(
        `INSERT INTO job(
          id, task_id, task_provider, action, status, priority_rank, repo_key, base_branch, dedupe_key,
          selection_reason, selection_context_json, scout_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.taskProvider,
        input.action,
        input.priorityRank,
        input.repoKey,
        input.baseBranch ?? null,
        input.dedupeKey,
        input.selectionReason,
        stableStringify(input.selectionContext ?? {}),
        input.scoutRunId ?? null,
        now,
        now,
      );

    return this.getJob(id);
  }

  listQueue(limit = 100): JobRecord[] {
    return this.sqlite
      .prepare(
        `SELECT id, task_id, task_provider, action, status, priority_rank, repo_key, base_branch, dedupe_key,
                selection_reason, selection_context_json, scout_run_id, created_at, updated_at, leased_at,
                started_at, finished_at, error_message
           FROM job
          WHERE status IN ('queued', 'leased', 'running')
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(limit)
      .map((row: unknown) => mapJob(row as SqliteRow));
  }

  listJobsByStatus(statuses: JobStatus[]): JobRecord[] {
    const placeholders = statuses.map(() => "?").join(", ");
    return this.sqlite
      .prepare(
        `SELECT id, task_id, task_provider, action, status, priority_rank, repo_key, base_branch, dedupe_key,
                selection_reason, selection_context_json, scout_run_id, created_at, updated_at, leased_at,
                started_at, finished_at, error_message
           FROM job WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .all(...statuses)
      .map((row: unknown) => mapJob(row as SqliteRow));
  }

  getJob(jobId: string): JobRecord {
    const row = this.sqlite
      .prepare(
        `SELECT id, task_id, task_provider, action, status, priority_rank, repo_key, base_branch, dedupe_key,
                selection_reason, selection_context_json, scout_run_id, created_at, updated_at, leased_at,
                started_at, finished_at, error_message
           FROM job WHERE id = ?`,
      )
      .get(jobId) as SqliteRow | undefined;

    if (!row) {
      throw new ForemanError("job_not_found", `Job not found: ${jobId}`, 404);
    }

    return mapJob(row);
  }

  updateJobStatus(
    jobId: string,
    status: JobStatus,
    patch: {
      startedAt?: string | null;
      leasedAt?: string | null;
      finishedAt?: string | null;
      errorMessage?: string | null;
    } = {},
  ): void {
    this.sqlite
      .prepare(
        `UPDATE job
            SET status = ?,
                updated_at = ?,
                started_at = COALESCE(?, started_at),
                leased_at = COALESCE(?, leased_at),
                finished_at = ?,
                error_message = ?
          WHERE id = ?`,
      )
      .run(
        status,
        isoNow(),
        patch.startedAt ?? null,
        patch.leasedAt ?? null,
        patch.finishedAt ?? null,
        patch.errorMessage ?? null,
        jobId,
      );
  }

  returnLeasedJobToQueue(jobId: string): void {
    this.sqlite
      .prepare(
        `UPDATE job
            SET status = 'queued',
                updated_at = ?,
                leased_at = NULL,
                started_at = NULL,
                finished_at = NULL,
                error_message = NULL
          WHERE id = ?
            AND status = 'leased'`,
      )
      .run(isoNow(), jobId);
  }

  claimQueuedJobForWorker(jobId: string, workerId: string): boolean {
    const now = isoNow();

    try {
      this.sqlite.transaction(() => {
        const workerResult = this.sqlite
          .prepare(
            `UPDATE worker
                SET status = 'leased',
                    current_attempt_id = NULL,
                    last_heartbeat_at = ?,
                    updated_at = ?
              WHERE id = ?
                AND status = 'idle'
                AND current_attempt_id IS NULL`,
          )
          .run(now, now, workerId);
        if (workerResult.changes !== 1) {
          throw new Error("worker_not_idle");
        }

        const jobResult = this.sqlite
          .prepare(
            `UPDATE job
                SET status = 'leased',
                    updated_at = ?,
                    leased_at = ?,
                    error_message = NULL
              WHERE id = ?
                AND status = 'queued'`,
          )
          .run(now, now, jobId);
        if (jobResult.changes !== 1) {
          throw new Error("job_not_queued");
        }
      })();

      return true;
    } catch {
      return false;
    }
  }
}
