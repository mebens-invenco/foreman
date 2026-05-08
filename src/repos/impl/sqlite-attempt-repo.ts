import { ForemanError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import type { AttemptStatus, RunnerProvider, TokenUsage } from "../../domain/index.js";
import type { AttemptEventRecord, AttemptRecord, AttemptRepo, RecoveredAttemptRecord } from "../attempt-repo.js";
import type { LeaseResourceType } from "../lease-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const parseTokensUsed = (raw: unknown): TokenUsage | null => {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<TokenUsage>;
    if (typeof parsed.inputTokens !== "number" || typeof parsed.outputTokens !== "number") {
      return null;
    }

    const tokens: TokenUsage = {
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    };
    if (typeof parsed.cacheCreationInputTokens === "number") {
      tokens.cacheCreationInputTokens = parsed.cacheCreationInputTokens;
    }
    if (typeof parsed.cacheReadInputTokens === "number") {
      tokens.cacheReadInputTokens = parsed.cacheReadInputTokens;
    }

    return tokens;
  } catch {
    return null;
  }
};

const serializeTokensUsed = (tokens: TokenUsage | null | undefined): string | null =>
  tokens ? stableStringify(tokens as unknown as Record<string, unknown>) : null;

const mapAttempt = (row: SqliteRow): AttemptRecord => ({
  id: String(row.id),
  jobId: String(row.job_id),
  jobKind: (row.job_kind as AttemptRecord["jobKind"] | null) ?? "task",
  taskId: (row.task_id as string | null) ?? null,
  target: (row.target as string | null) ?? null,
  cronJobId: (row.cron_job_id as string | null) ?? null,
  stage: (row.stage as string | null) ?? null,
  workerId: (row.worker_id as string | null) ?? null,
  attemptNumber: Number(row.attempt_number),
  runnerName: row.runner_name as RunnerProvider,
  runnerModel: String(row.runner_model),
  runnerVariant: String(row.runner_variant),
  runnerSessionId: (row.runner_session_id as string | null) ?? null,
  nativeSessionId: (row.native_session_id as string | null) ?? null,
  status: row.status as AttemptStatus,
  startedAt: String(row.started_at),
  finishedAt: (row.finished_at as string | null) ?? null,
  exitCode: row.exit_code === null ? null : Number(row.exit_code),
  signal: (row.signal as string | null) ?? null,
  summary: String(row.summary ?? ""),
  errorMessage: (row.error_message as string | null) ?? null,
  tokensUsed: parseTokensUsed(row.tokens_used_json),
});

export class SqliteAttemptRepo implements AttemptRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  private nextAttemptNumber(jobId: string): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(MAX(attempt_number), 0) AS max_attempt FROM execution_attempt WHERE job_id = ?")
      .get(jobId) as SqliteRow;
    return Number(row.max_attempt ?? 0) + 1;
  }

  private buildAttemptRecord(input: {
    jobId: string;
    workerId: string;
    runnerName: RunnerProvider;
    runnerModel: string;
    runnerVariant: string;
  }): AttemptRecord {
    return {
      id: newId(),
      jobId: input.jobId,
      jobKind: "task",
      taskId: null,
      target: null,
      cronJobId: null,
      stage: null,
      workerId: input.workerId,
      attemptNumber: this.nextAttemptNumber(input.jobId),
      runnerName: input.runnerName,
      runnerModel: input.runnerModel,
      runnerVariant: input.runnerVariant,
      runnerSessionId: null,
      nativeSessionId: null,
      status: "running",
      startedAt: isoNow(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      summary: "",
      errorMessage: null,
      tokensUsed: null,
    };
  }

  private insertAttemptRecord(record: AttemptRecord): void {
    this.sqlite
      .prepare(
        `INSERT INTO execution_attempt(
          id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id, status, started_at,
          finished_at, exit_code, signal, summary, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.jobId,
        record.workerId,
        record.attemptNumber,
        record.runnerName,
        record.runnerModel,
        record.runnerVariant,
        record.runnerSessionId,
        record.status,
        record.startedAt,
        null,
        null,
        null,
        record.summary,
        null,
      );
  }

  createAttempt(input: {
    jobId: string;
    workerId: string;
    runnerName: RunnerProvider;
    runnerModel: string;
    runnerVariant: string;
  }): AttemptRecord {
    const record = this.buildAttemptRecord(input);
    this.insertAttemptRecord(record);
    return this.getAttempt(record.id);
  }

  createAttemptWithLeases(input: {
    jobId: string;
    workerId: string;
    runnerName: RunnerProvider;
    runnerModel: string;
    runnerVariant: string;
    expiresAt: string;
    leases: Array<{ resourceType: LeaseResourceType; resourceKey: string }>;
  }): AttemptRecord | null {
    const record = this.buildAttemptRecord(input);

    try {
      this.sqlite.transaction(() => {
        this.insertAttemptRecord(record);
        const insertLease = this.sqlite.prepare(
          `INSERT INTO lease(id, resource_type, resource_key, worker_id, execution_attempt_id, acquired_at, heartbeat_at, expires_at, released_at, release_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        );

        for (const lease of input.leases) {
          insertLease.run(
            newId(),
            lease.resourceType,
            lease.resourceKey,
            input.workerId,
            record.id,
            record.startedAt,
            record.startedAt,
            input.expiresAt,
          );
        }
      })();

      return this.getAttempt(record.id);
    } catch {
      return null;
    }
  }

  linkRunnerSession(attemptId: string, runnerSessionId: string): void {
    this.sqlite.prepare("UPDATE execution_attempt SET runner_session_id = ? WHERE id = ?").run(runnerSessionId, attemptId);
  }

  finalizeAttempt(
    attemptId: string,
    status: AttemptStatus,
    patch: {
      finishedAt?: string;
      exitCode?: number | null;
      signal?: string | null;
      summary?: string;
      errorMessage?: string | null;
      tokensUsed?: TokenUsage | null;
    } = {},
  ): void {
    this.sqlite
      .prepare(
        `UPDATE execution_attempt
            SET status = ?,
                finished_at = ?,
                exit_code = ?,
                signal = ?,
                summary = ?,
                error_message = ?,
                tokens_used_json = ?
          WHERE id = ?`,
      )
      .run(
        status,
        patch.finishedAt ?? isoNow(),
        patch.exitCode ?? null,
        patch.signal ?? null,
        patch.summary ?? "",
        patch.errorMessage ?? null,
        serializeTokensUsed(patch.tokensUsed ?? null),
        attemptId,
      );
  }

  listAttempts(filters: { status?: AttemptStatus; jobId?: string; limit?: number; offset?: number } = {}): AttemptRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      conditions.push("ea.status = ?");
      params.push(filters.status);
    }

    if (filters.jobId) {
      conditions.push("ea.job_id = ?");
      params.push(filters.jobId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const paginationClause =
      filters.limit === undefined
        ? filters.offset === undefined
          ? ""
          : " LIMIT -1 OFFSET ?"
        : " LIMIT ? OFFSET ?";
    const paginationParams =
      filters.limit === undefined
        ? filters.offset === undefined
          ? []
          : [filters.offset]
        : [filters.limit, filters.offset ?? 0];

    return this.sqlite
      .prepare(
        `SELECT ea.id, ea.job_id, job.job_kind, job.task_id, job.repo_key AS target, job.cron_job_id, job.action AS stage,
                ea.worker_id, ea.attempt_number, ea.runner_name, ea.runner_model, ea.runner_variant, ea.runner_session_id,
                rs.native_session_id, ea.status, ea.started_at,
                ea.finished_at, ea.exit_code, ea.signal, ea.summary, ea.error_message, ea.tokens_used_json
           FROM execution_attempt ea
      LEFT JOIN job ON job.id = ea.job_id
      LEFT JOIN runner_session rs ON rs.id = ea.runner_session_id
                ${where}
       ORDER BY ea.started_at DESC${paginationClause}`,
      )
      .all(...params, ...paginationParams)
      .map((row: unknown) => mapAttempt(row as SqliteRow));
  }

  getAttempt(attemptId: string): AttemptRecord {
    const row = this.sqlite
      .prepare(
        `SELECT ea.id, ea.job_id, job.job_kind, job.task_id, job.repo_key AS target, job.cron_job_id, job.action AS stage,
                ea.worker_id, ea.attempt_number, ea.runner_name, ea.runner_model, ea.runner_variant, ea.runner_session_id,
                rs.native_session_id, ea.status, ea.started_at,
                ea.finished_at, ea.exit_code, ea.signal, ea.summary, ea.error_message, ea.tokens_used_json
           FROM execution_attempt ea
      LEFT JOIN job ON job.id = ea.job_id
      LEFT JOIN runner_session rs ON rs.id = ea.runner_session_id
          WHERE ea.id = ?`,
      )
      .get(attemptId) as SqliteRow | undefined;

    if (!row) {
      throw new ForemanError("attempt_not_found", `Attempt not found: ${attemptId}`, 404);
    }

    return mapAttempt(row);
  }

  latestAttemptForJob(jobId: string): AttemptRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT ea.id, ea.job_id, job.job_kind, job.task_id, job.repo_key AS target, job.cron_job_id, job.action AS stage,
                ea.worker_id, ea.attempt_number, ea.runner_name, ea.runner_model, ea.runner_variant, ea.runner_session_id,
                rs.native_session_id, ea.status, ea.started_at,
                ea.finished_at, ea.exit_code, ea.signal, ea.summary, ea.error_message, ea.tokens_used_json
           FROM execution_attempt ea
      LEFT JOIN job ON job.id = ea.job_id
      LEFT JOIN runner_session rs ON rs.id = ea.runner_session_id
          WHERE ea.job_id = ?
       ORDER BY ea.started_at DESC, ea.attempt_number DESC LIMIT 1`,
      )
      .get(jobId) as SqliteRow | undefined;

    return row ? mapAttempt(row) : null;
  }

  latestAttemptForTaskTarget(taskTargetId: string): AttemptRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT execution_attempt.id,
                execution_attempt.job_id,
                job.job_kind,
                job.task_id,
                job.repo_key AS target,
                job.cron_job_id,
                job.action AS stage,
                execution_attempt.worker_id,
                execution_attempt.attempt_number,
                execution_attempt.runner_name,
                execution_attempt.runner_model,
                execution_attempt.runner_variant,
                execution_attempt.runner_session_id,
                runner_session.native_session_id,
                execution_attempt.status,
                execution_attempt.started_at,
                execution_attempt.finished_at,
                execution_attempt.exit_code,
                execution_attempt.signal,
                execution_attempt.summary,
                execution_attempt.error_message,
                execution_attempt.tokens_used_json
            FROM execution_attempt
            JOIN job ON job.id = execution_attempt.job_id
       LEFT JOIN runner_session ON runner_session.id = execution_attempt.runner_session_id
          WHERE job.task_target_id = ?
          ORDER BY execution_attempt.started_at DESC, execution_attempt.attempt_number DESC
          LIMIT 1`,
      )
      .get(taskTargetId) as SqliteRow | undefined;

    return row ? mapAttempt(row) : null;
  }

  addAttemptEvent(attemptId: string, eventType: string, message: string, payload: Record<string, unknown> = {}): void {
    this.sqlite
      .prepare(
        "INSERT INTO execution_attempt_event(id, execution_attempt_id, event_type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(newId(), attemptId, eventType, message, stableStringify(payload), isoNow());
  }

  listAttemptEvents(attemptId: string): AttemptEventRecord[] {
    return this.sqlite
      .prepare(
        "SELECT id, event_type, message, payload_json, created_at FROM execution_attempt_event WHERE execution_attempt_id = ? ORDER BY created_at ASC",
      )
      .all(attemptId)
      .map((row: unknown) => {
        const mapped = row as SqliteRow;
        return {
          id: String(mapped.id),
          eventType: String(mapped.event_type),
          message: String(mapped.message),
          payload: JSON.parse(String(mapped.payload_json ?? "{}")),
          createdAt: String(mapped.created_at),
        };
      });
  }

  recoverOrphanedRunningAttempts(reason: string, options: { excludeWorkerIds?: string[] } = {}): RecoveredAttemptRecord[] {
    const now = isoNow();
    const recovered: RecoveredAttemptRecord[] = [];
    const excludeWorkerIds = options.excludeWorkerIds ?? [];
    const excludedWorkerClause =
      excludeWorkerIds.length === 0
        ? ""
        : `\n             AND (ea.worker_id IS NULL OR ea.worker_id NOT IN (${excludeWorkerIds.map(() => "?").join(", ")}))`;
    const rows = this.sqlite
      .prepare(
        `SELECT ea.id AS attempt_id, ea.job_id, ea.worker_id
           FROM execution_attempt ea
      LEFT JOIN lease l
             ON l.execution_attempt_id = ea.id
            AND l.released_at IS NULL
           WHERE ea.status = 'running'
             AND l.id IS NULL${excludedWorkerClause}
        ORDER BY ea.started_at ASC`,
      )
      .all(...excludeWorkerIds) as Array<{ attempt_id: string; job_id: string; worker_id: string | null }>;

    this.sqlite.transaction(() => {
      const finalizeAttempt = this.sqlite.prepare(
        `UPDATE execution_attempt
            SET status = 'canceled',
                finished_at = ?,
                summary = ?,
                error_message = ?
          WHERE id = ?
            AND status = 'running'`,
      );
      const finalizeJob = this.sqlite.prepare(
        `UPDATE job
            SET status = 'canceled',
                updated_at = ?,
                finished_at = ?,
                error_message = ?
          WHERE id = ?
            AND status IN ('leased', 'running')`,
      );
      const addEvent = this.sqlite.prepare(
        "INSERT INTO execution_attempt_event(id, execution_attempt_id, event_type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const releaseLeases = this.sqlite.prepare(
        "UPDATE lease SET released_at = ?, release_reason = 'startup_recovery' WHERE execution_attempt_id = ? AND released_at IS NULL",
      );
      const resetWorker = this.sqlite.prepare(
        `UPDATE worker
            SET status = 'idle',
                current_attempt_id = NULL,
                last_heartbeat_at = ?,
                updated_at = ?
          WHERE current_attempt_id = ?`,
      );

      for (const row of rows) {
        finalizeAttempt.run(now, reason, reason, row.attempt_id);
        finalizeJob.run(now, now, reason, row.job_id);
        addEvent.run(newId(), row.attempt_id, "attempt_recovered", reason, stableStringify({ recovery: "startup" }), now);
        releaseLeases.run(now, row.attempt_id);
        resetWorker.run(now, now, row.attempt_id);
        recovered.push({ attemptId: row.attempt_id, jobId: row.job_id, workerId: row.worker_id });
      }
    })();

    return recovered;
  }
}
