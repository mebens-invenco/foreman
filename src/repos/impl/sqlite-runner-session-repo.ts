import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type { RunnerProvider, RunnerSessionRole } from "../../domain/index.js";
import type { RunnerSessionRecord, RunnerSessionRepo, RunnerSessionSelector } from "../runner-session-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const mapRunnerSession = (row: SqliteRow): RunnerSessionRecord => ({
  id: String(row.id),
  taskTargetId: String(row.task_target_id),
  role: row.role as RunnerSessionRole,
  runnerName: row.runner_name as RunnerProvider,
  runnerModel: String(row.runner_model),
  runnerVariant: String(row.runner_variant),
  nativeSessionId: (row.native_session_id as string | null) ?? null,
  isActive: Number(row.is_active) === 1,
  lastAttemptId: (row.last_attempt_id as string | null) ?? null,
  lastWorktreeHeadSha: (row.last_worktree_head_sha as string | null) ?? null,
  lastReviewHeadSha: (row.last_review_head_sha as string | null) ?? null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class SqliteRunnerSessionRepo implements RunnerSessionRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  getActiveSession(selector: RunnerSessionSelector): RunnerSessionRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, task_target_id, role, runner_name, runner_model, runner_variant, native_session_id, is_active,
                last_attempt_id, last_worktree_head_sha, last_review_head_sha, created_at, updated_at
           FROM runner_session
          WHERE task_target_id = ?
            AND role = ?
            AND runner_name = ?
            AND runner_model = ?
            AND runner_variant = ?
            AND is_active = 1
            AND native_session_id IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(selector.taskTargetId, selector.role, selector.runnerName, selector.runnerModel, selector.runnerVariant) as SqliteRow | undefined;

    return row ? mapRunnerSession(row) : null;
  }

  createSession(input: RunnerSessionSelector & { isActive: boolean; nativeSessionId?: string | null }): RunnerSessionRecord {
    const record: RunnerSessionRecord = {
      id: newId(),
      taskTargetId: input.taskTargetId,
      role: input.role,
      runnerName: input.runnerName,
      runnerModel: input.runnerModel,
      runnerVariant: input.runnerVariant,
      nativeSessionId: input.nativeSessionId ?? null,
      isActive: input.isActive,
      lastAttemptId: null,
      lastWorktreeHeadSha: null,
      lastReviewHeadSha: null,
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };

    this.sqlite
      .prepare(
        `INSERT INTO runner_session(
          id, task_target_id, role, runner_name, runner_model, runner_variant, native_session_id, is_active,
          last_attempt_id, last_worktree_head_sha, last_review_head_sha, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.taskTargetId,
        record.role,
        record.runnerName,
        record.runnerModel,
        record.runnerVariant,
        record.nativeSessionId,
        record.isActive ? 1 : 0,
        record.lastAttemptId,
        record.lastWorktreeHeadSha,
        record.lastReviewHeadSha,
        record.createdAt,
        record.updatedAt,
      );

    return record;
  }

  updateSession(
    sessionId: string,
    patch: {
      nativeSessionId?: string | null;
      lastAttemptId?: string | null;
      lastWorktreeHeadSha?: string | null;
      lastReviewHeadSha?: string | null;
      isActive?: boolean;
    },
  ): void {
    const now = isoNow();
    const setClauses: string[] = [];
    const values: unknown[] = [];

    const addSet = (column: string, value: unknown): void => {
      setClauses.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.nativeSessionId !== undefined) {
      addSet("native_session_id", patch.nativeSessionId ?? null);
    }
    if (patch.lastAttemptId !== undefined) {
      addSet("last_attempt_id", patch.lastAttemptId ?? null);
    }
    if (patch.lastWorktreeHeadSha !== undefined) {
      addSet("last_worktree_head_sha", patch.lastWorktreeHeadSha ?? null);
    }
    if (patch.lastReviewHeadSha !== undefined) {
      addSet("last_review_head_sha", patch.lastReviewHeadSha ?? null);
    }
    if (patch.isActive !== undefined) {
      addSet("is_active", patch.isActive ? 1 : 0);
    }
    addSet("updated_at", now);

    this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare("SELECT task_target_id, role, runner_name, runner_model, runner_variant FROM runner_session WHERE id = ?")
        .get(sessionId) as SqliteRow | undefined;

      if (patch.isActive === true && existing) {
        this.sqlite
          .prepare(
            `UPDATE runner_session
                SET is_active = 0,
                    updated_at = ?
              WHERE task_target_id = ?
                AND role = ?
                AND runner_name = ?
                AND runner_model = ?
                AND runner_variant = ?
                AND id <> ?`,
          )
          .run(
            now,
            existing.task_target_id,
            existing.role,
            existing.runner_name,
            existing.runner_model,
            existing.runner_variant,
            sessionId,
          );
      }

      this.sqlite.prepare(`UPDATE runner_session SET ${setClauses.join(", ")} WHERE id = ?`).run(...values, sessionId);
    })();
  }
}
