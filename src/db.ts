import { promises as fs } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  ActionType,
  AttemptStatus,
  JobStatus,
  ReviewContext,
  TaskPriority,
  WorkerResult,
} from "./domain.js";
import { ForemanError } from "./lib/errors.js";
import { ensureDir, sha256File } from "./lib/fs.js";
import { newId } from "./lib/ids.js";
import { stableStringify } from "./lib/json.js";
import { isoNow } from "./lib/time.js";

export type SqliteDatabase = Database.Database;

export type JobRecord = {
  id: string;
  taskId: string;
  taskProvider: "linear" | "file";
  action: ActionType;
  status: JobStatus;
  priorityRank: number;
  repoKey: string;
  baseBranch: string | null;
  dedupeKey: string;
  selectionReason: string;
  selectionContext: Record<string, unknown>;
  scoutRunId: string | null;
  createdAt: string;
  updatedAt: string;
  leasedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
};

export type AttemptRecord = {
  id: string;
  jobId: string;
  workerId: string | null;
  attemptNumber: number;
  runnerName: "opencode";
  runnerModel: string;
  runnerVariant: string;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  summary: string;
  errorMessage: string | null;
};

export type WorkerRecord = {
  id: string;
  slot: number;
  status: "idle" | "leased" | "running" | "stopping" | "offline";
  currentAttemptId: string | null;
  lastHeartbeatAt: string;
};

export type RecoveredAttemptRecord = {
  attemptId: string;
  jobId: string;
  workerId: string | null;
};

export type ScoutRunTrigger = "startup" | "poll" | "worker_finished" | "task_mutation" | "lease_change" | "manual";

const mapJob = (row: Record<string, unknown>): JobRecord => ({
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

const mapAttempt = (row: Record<string, unknown>): AttemptRecord => ({
  id: String(row.id),
  jobId: String(row.job_id),
  workerId: (row.worker_id as string | null) ?? null,
  attemptNumber: Number(row.attempt_number),
  runnerName: row.runner_name as "opencode",
  runnerModel: String(row.runner_model),
  runnerVariant: String(row.runner_variant),
  status: row.status as AttemptStatus,
  startedAt: String(row.started_at),
  finishedAt: (row.finished_at as string | null) ?? null,
  exitCode: row.exit_code === null ? null : Number(row.exit_code),
  signal: (row.signal as string | null) ?? null,
  summary: String(row.summary ?? ""),
  errorMessage: (row.error_message as string | null) ?? null,
});

const mapWorker = (row: Record<string, unknown>): WorkerRecord => ({
  id: String(row.id),
  slot: Number(row.slot),
  status: row.status as WorkerRecord["status"],
  currentAttemptId: (row.current_attempt_id as string | null) ?? null,
  lastHeartbeatAt: String(row.last_heartbeat_at),
});

export const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
  await ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

export const applyMigrations = async (db: SqliteDatabase, projectRoot: string): Promise<void> => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );

  const migrationsDir = path.join(projectRoot, "migrations");
  const migrationFiles = (await fs.readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  const applied = new Map(
    db
      .prepare("SELECT version, checksum FROM schema_migration")
      .all()
      .map((row: unknown) => [String((row as Record<string, unknown>).version), String((row as Record<string, unknown>).checksum)]),
  );

  for (const fileName of migrationFiles) {
    const filePath = path.join(migrationsDir, fileName);
    const checksum = await sha256File(filePath);
    const existing = applied.get(fileName);

    if (existing) {
      if (existing !== checksum) {
        throw new ForemanError("migration_checksum_mismatch", `Migration ${fileName} checksum mismatch`, 500);
      }

      continue;
    }

    const sql = await fs.readFile(filePath, "utf8");

    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migration(version, checksum, applied_at) VALUES (?, ?, ?)").run(fileName, checksum, isoNow());
    })();
  }
};

export class ForemanDb {
  constructor(readonly sqlite: SqliteDatabase) {}

  close(): void {
    this.sqlite.close();
  }

  ensureWorkerSlots(concurrency: number): void {
    const now = isoNow();
    const insert = this.sqlite.prepare(
      "INSERT INTO worker(id, slot, status, process_id, current_attempt_id, started_at, last_heartbeat_at, updated_at) VALUES (?, ?, 'idle', NULL, NULL, ?, ?, ?)",
    );
    const existing = new Set(
      this.sqlite
        .prepare("SELECT slot FROM worker")
        .all()
        .map((row: unknown) => Number((row as Record<string, unknown>).slot)),
    );

    const tx = this.sqlite.transaction(() => {
      for (let slot = 1; slot <= concurrency; slot += 1) {
        if (!existing.has(slot)) {
          insert.run(newId(), slot, now, now, now);
        }
      }
    });

    tx();
  }

  listWorkers(): WorkerRecord[] {
    return this.sqlite
      .prepare("SELECT id, slot, status, current_attempt_id, last_heartbeat_at FROM worker ORDER BY slot ASC")
      .all()
      .map((row: unknown) => mapWorker(row as Record<string, unknown>));
  }

  updateWorkerStatus(workerId: string, status: WorkerRecord["status"], currentAttemptId: string | null): void {
    this.sqlite
      .prepare(
        "UPDATE worker SET status = ?, current_attempt_id = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, currentAttemptId, isoNow(), isoNow(), workerId);
  }

  claimQueuedJobForWorker(jobId: string, workerId: string): boolean {
    const now = isoNow();

    try {
      const tx = this.sqlite.transaction(() => {
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
      });

      tx();
      return true;
    } catch {
      return false;
    }
  }

  heartbeatWorker(workerId: string, attemptId: string | null, expiresAt: string): void {
    const now = isoNow();
    const tx = this.sqlite.transaction(() => {
      this.sqlite
        .prepare("UPDATE worker SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, workerId);

      if (attemptId) {
        this.sqlite
          .prepare(
            "UPDATE lease SET heartbeat_at = ?, expires_at = ? WHERE worker_id = ? AND execution_attempt_id = ? AND released_at IS NULL",
          )
          .run(now, expiresAt, workerId, attemptId);
      }
    });

    tx();
  }

  createScoutRun(input: {
    triggerType: ScoutRunTrigger;
    candidateCount: number;
    activeCount: number;
    terminalCount: number;
    summary?: Record<string, unknown>;
  }): string {
    const id = newId();
    this.sqlite
      .prepare(
        `INSERT INTO scout_run(
          id, trigger_type, status, started_at, candidate_count, active_count, terminal_count, summary_json
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)` ,
      )
      .run(id, input.triggerType, isoNow(), input.candidateCount, input.activeCount, input.terminalCount, stableStringify(input.summary ?? {}));
    return id;
  }

  completeScoutRun(input: {
    id: string;
    selectedJobId?: string | null;
    selectedAction?: ActionType | null;
    selectedTaskId?: string | null;
    selectedReason?: string;
    status?: "completed" | "failed";
    summary?: Record<string, unknown>;
    errorMessage?: string | null;
  }): void {
    this.sqlite
      .prepare(
        `UPDATE scout_run
            SET status = ?,
                finished_at = ?,
                selected_job_id = ?,
                selected_action = ?,
                selected_task_id = ?,
                selected_reason = ?,
                summary_json = ?,
                error_message = ?
          WHERE id = ?`,
      )
      .run(
        input.status ?? "completed",
        isoNow(),
        input.selectedJobId ?? null,
        input.selectedAction ?? null,
        input.selectedTaskId ?? null,
        input.selectedReason ?? "",
        stableStringify(input.summary ?? {}),
        input.errorMessage ?? null,
        input.id,
      );
  }

  listScoutRuns(limit = 50): Record<string, unknown>[] {
    return this.sqlite
      .prepare(
        "SELECT id, trigger_type, status, started_at, finished_at, selected_action, selected_task_id, candidate_count, active_count, terminal_count FROM scout_run ORDER BY started_at DESC LIMIT ?",
      )
      .all(limit)
      .map((row: unknown) => ({
        id: (row as Record<string, unknown>).id,
        triggerType: (row as Record<string, unknown>).trigger_type,
        status: (row as Record<string, unknown>).status,
        startedAt: (row as Record<string, unknown>).started_at,
        finishedAt: (row as Record<string, unknown>).finished_at,
        selectedAction: (row as Record<string, unknown>).selected_action,
        selectedTaskId: (row as Record<string, unknown>).selected_task_id,
        candidateCount: (row as Record<string, unknown>).candidate_count,
        activeCount: (row as Record<string, unknown>).active_count,
        terminalCount: (row as Record<string, unknown>).terminal_count,
      }));
  }

  activeJobCount(): number {
    const row = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM job WHERE status IN ('queued', 'leased', 'running')")
      .get() as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  hasActiveDedupeKey(dedupeKey: string): boolean {
    const row = this.sqlite
      .prepare("SELECT 1 AS present FROM job WHERE dedupe_key = ? AND status IN ('queued', 'leased', 'running') LIMIT 1")
      .get(dedupeKey) as Record<string, unknown> | undefined;
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
      .map((row: unknown) => mapJob(row as Record<string, unknown>));
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
      .map((row: unknown) => mapJob(row as Record<string, unknown>));
  }

  getJob(jobId: string): JobRecord {
    const row = this.sqlite
      .prepare(
        `SELECT id, task_id, task_provider, action, status, priority_rank, repo_key, base_branch, dedupe_key,
                selection_reason, selection_context_json, scout_run_id, created_at, updated_at, leased_at,
                started_at, finished_at, error_message
           FROM job WHERE id = ?`,
      )
      .get(jobId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new ForemanError("job_not_found", `Job not found: ${jobId}`, 404);
    }

    return mapJob(row);
  }

  updateJobStatus(jobId: string, status: JobStatus, patch: { startedAt?: string | null; leasedAt?: string | null; finishedAt?: string | null; errorMessage?: string | null } = {}): void {
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
      .run(status, isoNow(), patch.startedAt ?? null, patch.leasedAt ?? null, patch.finishedAt ?? null, patch.errorMessage ?? null, jobId);
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

  nextAttemptNumber(jobId: string): number {
    const row = this.sqlite
      .prepare("SELECT COALESCE(MAX(attempt_number), 0) AS max_attempt FROM execution_attempt WHERE job_id = ?")
      .get(jobId) as Record<string, unknown>;
    return Number(row.max_attempt ?? 0) + 1;
  }

  private buildAttemptRecord(input: {
    jobId: string;
    workerId: string;
    runnerModel: string;
    runnerVariant: string;
  }): AttemptRecord {
    return {
      id: newId(),
      jobId: input.jobId,
      workerId: input.workerId,
      attemptNumber: this.nextAttemptNumber(input.jobId),
      runnerName: "opencode",
      runnerModel: input.runnerModel,
      runnerVariant: input.runnerVariant,
      status: "running",
      startedAt: isoNow(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      summary: "",
      errorMessage: null,
    };
  }

  private insertAttemptRecord(record: AttemptRecord): void {
    this.sqlite
      .prepare(
        `INSERT INTO execution_attempt(
          id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, status, started_at,
          finished_at, exit_code, signal, summary, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.jobId,
        record.workerId,
        record.attemptNumber,
        record.runnerName,
        record.runnerModel,
        record.runnerVariant,
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
    runnerModel: string;
    runnerVariant: string;
  }): AttemptRecord {
    const record = this.buildAttemptRecord(input);
    this.insertAttemptRecord(record);

    return record;
  }

  createAttemptWithLeases(input: {
    jobId: string;
    workerId: string;
    runnerModel: string;
    runnerVariant: string;
    expiresAt: string;
    leases: Array<{ resourceType: "job" | "task" | "branch"; resourceKey: string }>;
  }): AttemptRecord | null {
    const record = this.buildAttemptRecord(input);

    try {
      const tx = this.sqlite.transaction(() => {
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
      });

      tx();
      return record;
    } catch {
      return null;
    }
  }

  finalizeAttempt(attemptId: string, status: AttemptStatus, patch: { finishedAt?: string; exitCode?: number | null; signal?: string | null; summary?: string; errorMessage?: string | null } = {}): void {
    this.sqlite
      .prepare(
        `UPDATE execution_attempt
            SET status = ?,
                finished_at = ?,
                exit_code = ?,
                signal = ?,
                summary = ?,
                error_message = ?
          WHERE id = ?`,
      )
      .run(status, patch.finishedAt ?? isoNow(), patch.exitCode ?? null, patch.signal ?? null, patch.summary ?? "", patch.errorMessage ?? null, attemptId);
  }

  listAttempts(filters: { status?: AttemptStatus; jobId?: string; limit?: number } = {}): AttemptRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }

    if (filters.jobId) {
      conditions.push("job_id = ?");
      params.push(filters.jobId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;

    return this.sqlite
      .prepare(
        `SELECT id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, status, started_at,
                finished_at, exit_code, signal, summary, error_message
           FROM execution_attempt ${where} ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((row: unknown) => mapAttempt(row as Record<string, unknown>));
  }

  getAttempt(attemptId: string): AttemptRecord {
    const row = this.sqlite
      .prepare(
        `SELECT id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, status, started_at,
                finished_at, exit_code, signal, summary, error_message
           FROM execution_attempt WHERE id = ?`,
      )
      .get(attemptId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new ForemanError("attempt_not_found", `Attempt not found: ${attemptId}`, 404);
    }

    return mapAttempt(row);
  }

  latestAttemptForJob(jobId: string): AttemptRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, status, started_at,
                finished_at, exit_code, signal, summary, error_message
           FROM execution_attempt WHERE job_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;

    return row ? mapAttempt(row) : null;
  }

  addAttemptEvent(attemptId: string, eventType: string, message: string, payload: Record<string, unknown> = {}): void {
    this.sqlite
      .prepare(
        "INSERT INTO execution_attempt_event(id, execution_attempt_id, event_type, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(newId(), attemptId, eventType, message, stableStringify(payload), isoNow());
  }

  listAttemptEvents(attemptId: string): Record<string, unknown>[] {
    return this.sqlite
      .prepare(
        "SELECT id, event_type, message, payload_json, created_at FROM execution_attempt_event WHERE execution_attempt_id = ? ORDER BY created_at ASC",
      )
      .all(attemptId)
      .map((row: unknown) => ({
        id: (row as Record<string, unknown>).id,
        eventType: (row as Record<string, unknown>).event_type,
        message: (row as Record<string, unknown>).message,
        payload: JSON.parse(String((row as Record<string, unknown>).payload_json ?? "{}")),
        createdAt: (row as Record<string, unknown>).created_at,
      }));
  }

  createArtifact(input: {
    ownerType: "workspace" | "job" | "execution_attempt" | "scout_run";
    ownerId: string;
    artifactType: "log" | "rendered_prompt" | "parsed_result" | "plan_prompt" | "plan_context";
    relativePath: string;
    mediaType: string;
    sizeBytes: number;
    sha256?: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO artifact(
          id, owner_type, owner_id, artifact_type, relative_path, media_type, size_bytes, sha256, created_at
        ) VALUES (
          COALESCE((SELECT id FROM artifact WHERE relative_path = ?), ?), ?, ?, ?, ?, ?, ?, ?, ?
        )`,
      )
      .run(
        input.relativePath,
        newId(),
        input.ownerType,
        input.ownerId,
        input.artifactType,
        input.relativePath,
        input.mediaType,
        input.sizeBytes,
        input.sha256 ?? null,
        isoNow(),
      );
  }

  listArtifacts(ownerType?: string, ownerId?: string): Record<string, unknown>[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (ownerType) {
      clauses.push("owner_type = ?");
      params.push(ownerType);
    }
    if (ownerId) {
      clauses.push("owner_id = ?");
      params.push(ownerId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.sqlite
      .prepare(
        `SELECT id, owner_type, owner_id, artifact_type, relative_path, media_type, size_bytes, sha256, created_at
           FROM artifact ${where} ORDER BY created_at DESC`,
      )
      .all(...params)
      .map((row: unknown) => ({
        id: (row as Record<string, unknown>).id,
        ownerType: (row as Record<string, unknown>).owner_type,
        ownerId: (row as Record<string, unknown>).owner_id,
        artifactType: (row as Record<string, unknown>).artifact_type,
        relativePath: (row as Record<string, unknown>).relative_path,
        mediaType: (row as Record<string, unknown>).media_type,
        sizeBytes: (row as Record<string, unknown>).size_bytes,
        sha256: (row as Record<string, unknown>).sha256,
        createdAt: (row as Record<string, unknown>).created_at,
      }));
  }

  acquireLease(input: {
    resourceType: "job" | "task" | "branch";
    resourceKey: string;
    workerId: string;
    attemptId?: string;
    expiresAt: string;
  }): boolean {
    try {
      this.sqlite
        .prepare(
          `INSERT INTO lease(id, resource_type, resource_key, worker_id, execution_attempt_id, acquired_at, heartbeat_at, expires_at, released_at, release_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(newId(), input.resourceType, input.resourceKey, input.workerId, input.attemptId ?? null, isoNow(), isoNow(), input.expiresAt);
      return true;
    } catch {
      return false;
    }
  }

  releaseLeasesForAttempt(attemptId: string, reason: string): void {
    this.sqlite
      .prepare(
        "UPDATE lease SET released_at = ?, release_reason = ? WHERE execution_attempt_id = ? AND released_at IS NULL",
      )
      .run(isoNow(), reason, attemptId);
  }

  releaseLeaseByResource(resourceType: "job" | "task" | "branch", resourceKey: string, reason: string): void {
    this.sqlite
      .prepare(
        "UPDATE lease SET released_at = ?, release_reason = ? WHERE resource_type = ? AND resource_key = ? AND released_at IS NULL",
      )
      .run(isoNow(), reason, resourceType, resourceKey);
  }

  hasActiveTaskLease(taskId: string): boolean {
    const row = this.sqlite
      .prepare("SELECT 1 AS present FROM lease WHERE resource_type = 'task' AND resource_key = ? AND released_at IS NULL LIMIT 1")
      .get(taskId) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  reapExpiredLeases(now: string): number {
    const result = this.sqlite
      .prepare(
        "UPDATE lease SET released_at = ?, release_reason = 'expired' WHERE released_at IS NULL AND expires_at <= ?",
      )
      .run(now, now);
    return result.changes;
  }

  recoverOrphanedRunningAttempts(reason: string): RecoveredAttemptRecord[] {
    const now = isoNow();
    const recovered: RecoveredAttemptRecord[] = [];
    const rows = this.sqlite
      .prepare(
        `SELECT ea.id AS attempt_id, ea.job_id, ea.worker_id
           FROM execution_attempt ea
      LEFT JOIN lease l
             ON l.execution_attempt_id = ea.id
            AND l.released_at IS NULL
          WHERE ea.status = 'running'
            AND l.id IS NULL
       ORDER BY ea.started_at ASC`,
      )
      .all() as Array<{ attempt_id: string; job_id: string; worker_id: string | null }>;

    const tx = this.sqlite.transaction(() => {
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
    });

    tx();
    return recovered;
  }

  getReviewCheckpoint(taskId: string, prUrl: string): Record<string, unknown> | null {
    const row = this.sqlite
      .prepare(
        "SELECT id, task_id, pr_url, head_sha, latest_review_summary_id, latest_conversation_comment_id, checks_fingerprint, merge_state, recorded_at, source_attempt_id FROM review_checkpoint WHERE task_id = ? AND pr_url = ?",
      )
      .get(taskId, prUrl) as Record<string, unknown> | undefined;
    return row ?? null;
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
        ) VALUES (
          COALESCE((SELECT id FROM review_checkpoint WHERE task_id = ? AND pr_url = ?), ?), ?, ?, ?, ?, ?, ?, ?, ?
        )
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
        input.taskId,
        input.prUrl,
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

  addLearning(input: {
    id?: string;
    title: string;
    repo: string;
    confidence: "emerging" | "established" | "proven";
    content: string;
    tags: string[];
  }): string {
    const id = input.id ?? newId();
    this.sqlite
      .prepare(
        "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)",
      )
      .run(id, input.title, input.repo, JSON.stringify(input.tags), input.confidence, input.content, isoNow(), isoNow());
    return id;
  }

  updateLearning(input: {
    id: string;
    title?: string;
    repo?: string;
    confidence?: "emerging" | "established" | "proven";
    content?: string;
    tags?: string[];
    markApplied?: boolean;
  }): void {
    const current = this.sqlite
      .prepare("SELECT title, repo, tags, confidence, content, applied_count FROM learning WHERE id = ?")
      .get(input.id) as Record<string, unknown> | undefined;

    if (!current) {
      throw new ForemanError("learning_not_found", `Learning not found: ${input.id}`);
    }

    this.sqlite
      .prepare(
        `UPDATE learning
            SET title = ?, repo = ?, tags = ?, confidence = ?, content = ?, applied_count = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        input.title ?? current.title,
        input.repo ?? current.repo,
        input.tags ? JSON.stringify(input.tags) : current.tags,
        input.confidence ?? current.confidence,
        input.content ?? current.content,
        input.markApplied ? Number(current.applied_count ?? 0) + 1 : current.applied_count,
        isoNow(),
        input.id,
      );
  }

  listLearnings(filters: { search?: string; repo?: string; limit?: number; offset?: number } = {}): Record<string, unknown>[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.search) {
      clauses.push("rowid IN (SELECT rowid FROM learning_fts WHERE learning_fts MATCH ?)");
      params.push(filters.search);
    }

    if (filters.repo) {
      clauses.push("repo = ?");
      params.push(filters.repo);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.sqlite
      .prepare(
        `SELECT id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at
           FROM learning ${where}
          ORDER BY updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit ?? 50, filters.offset ?? 0)
      .map((row: unknown) => ({
        id: (row as Record<string, unknown>).id,
        title: (row as Record<string, unknown>).title,
        repo: (row as Record<string, unknown>).repo,
        tags: JSON.parse(String((row as Record<string, unknown>).tags ?? "[]")),
        confidence: (row as Record<string, unknown>).confidence,
        content: (row as Record<string, unknown>).content,
        appliedCount: (row as Record<string, unknown>).applied_count,
        readCount: (row as Record<string, unknown>).read_count,
        createdAt: (row as Record<string, unknown>).created_at,
        updatedAt: (row as Record<string, unknown>).updated_at,
      }));
  }

  addHistoryStep(input: { stepId?: string; createdAt?: string; stage: string; issue: string; summary: string; repos?: Array<{ path: string; beforeSha: string; afterSha: string }> }): string {
    const stepId = input.stepId ?? newId();
    const createdAt = input.createdAt ?? isoNow();
    const tx = this.sqlite.transaction(() => {
      this.sqlite
        .prepare("INSERT INTO history_step(step_id, created_at, stage, issue, summary) VALUES (?, ?, ?, ?, ?)")
        .run(stepId, createdAt, input.stage, input.issue, input.summary);

      if (input.repos) {
        const insertRepo = this.sqlite.prepare(
          "INSERT INTO history_step_repo(step_id, position, path, before_sha, after_sha) VALUES (?, ?, ?, ?, ?)",
        );
        input.repos.forEach((repo, index) => {
          insertRepo.run(stepId, index + 1, repo.path, repo.beforeSha, repo.afterSha);
        });
      }
    });
    tx();
    return stepId;
  }

  listHistory(limit = 50): Record<string, unknown>[] {
    return this.sqlite
      .prepare(
        `SELECT h.step_id, h.created_at, h.stage, h.issue, h.summary,
                COALESCE(json_group_array(
                  CASE WHEN r.step_id IS NULL THEN NULL ELSE json_object('path', r.path, 'beforeSha', r.before_sha, 'afterSha', r.after_sha, 'position', r.position) END
                ), '[]') AS repos_json
           FROM history_step h
      LEFT JOIN history_step_repo r ON r.step_id = h.step_id
       GROUP BY h.step_id
       ORDER BY h.created_at DESC
       LIMIT ?`,
      )
      .all(limit)
      .map((row: unknown) => ({
        stepId: (row as Record<string, unknown>).step_id,
        createdAt: (row as Record<string, unknown>).created_at,
        stage: (row as Record<string, unknown>).stage,
        issue: (row as Record<string, unknown>).issue,
        summary: (row as Record<string, unknown>).summary,
        repos: JSON.parse(String((row as Record<string, unknown>).repos_json ?? "[]")).filter(Boolean),
      }));
  }

  assertLegacyImportDestinationEmpty(): void {
    const tables = ["learning", "history_step", "history_step_repo"];
    for (const table of tables) {
      const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>;
      if (Number(row.count ?? 0) > 0) {
        throw new ForemanError("legacy_import_destination_not_empty", `Destination table ${table} must be empty before import`);
      }
    }
  }

  importLegacyDatabase(legacyDbPath: string): void {
    this.assertLegacyImportDestinationEmpty();
    const legacy = new Database(legacyDbPath, { readonly: true });
    try {
      const learnings = legacy.prepare("SELECT id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at FROM learning").all() as Array<Record<string, unknown>>;
      const historySteps = legacy.prepare("SELECT step_id, created_at, stage, issue, summary FROM history_step").all() as Array<Record<string, unknown>>;
      const historyRepos = legacy.prepare("SELECT step_id, position, path, before_sha, after_sha FROM history_step_repo").all() as Array<Record<string, unknown>>;

      const tx = this.sqlite.transaction(() => {
        const insertLearning = this.sqlite.prepare(
          "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const insertHistory = this.sqlite.prepare(
          "INSERT INTO history_step(step_id, created_at, stage, issue, summary) VALUES (?, ?, ?, ?, ?)",
        );
        const insertHistoryRepo = this.sqlite.prepare(
          "INSERT INTO history_step_repo(step_id, position, path, before_sha, after_sha) VALUES (?, ?, ?, ?, ?)",
        );

        for (const row of learnings) {
          insertLearning.run(
            row.id,
            row.title,
            row.repo,
            row.tags,
            row.confidence,
            row.content,
            row.applied_count,
            row.read_count,
            row.created_at,
            row.updated_at,
          );
        }

        for (const row of historySteps) {
          insertHistory.run(row.step_id, row.created_at, row.stage, row.issue, row.summary);
        }

        for (const row of historyRepos) {
          insertHistoryRepo.run(row.step_id, row.position, row.path, row.before_sha, row.after_sha);
        }
      });
      tx();
    } finally {
      legacy.close();
    }
  }
}

export const priorityToRank = (priority: TaskPriority): number => {
  switch (priority) {
    case "urgent":
      return 1;
    case "high":
      return 2;
    case "normal":
      return 3;
    case "none":
      return 4;
    case "low":
      return 5;
  }
};

export const deriveAttemptStatus = (workerResult: WorkerResult): AttemptStatus => {
  switch (workerResult.outcome) {
    case "completed":
    case "no_action_needed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
  }
};
