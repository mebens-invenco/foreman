import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import { newId } from "../../lib/ids.js";
import type { ActionType } from "../../domain/index.js";
import type { ScoutRunRecord, ScoutRunRepo, ScoutRunTrigger } from "../scout-run-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

export class SqliteScoutRunRepo implements ScoutRunRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

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
        ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.triggerType,
        isoNow(),
        input.candidateCount,
        input.activeCount,
        input.terminalCount,
        stableStringify(input.summary ?? {}),
      );
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

  listScoutRuns(limit = 50): ScoutRunRecord[] {
    return this.sqlite
      .prepare(
        "SELECT id, trigger_type, status, started_at, finished_at, selected_action, selected_task_id, candidate_count, active_count, terminal_count FROM scout_run ORDER BY started_at DESC LIMIT ?",
      )
      .all(limit)
      .map((row: unknown) => {
        const mapped = row as SqliteRow;
        return {
          id: String(mapped.id),
          triggerType: mapped.trigger_type as ScoutRunTrigger,
          status: mapped.status as ScoutRunRecord["status"],
          startedAt: String(mapped.started_at),
          finishedAt: (mapped.finished_at as string | null) ?? null,
          selectedAction: (mapped.selected_action as ActionType | null) ?? null,
          selectedTaskId: (mapped.selected_task_id as string | null) ?? null,
          candidateCount: Number(mapped.candidate_count),
          activeCount: Number(mapped.active_count),
          terminalCount: Number(mapped.terminal_count),
        };
      });
  }
}
