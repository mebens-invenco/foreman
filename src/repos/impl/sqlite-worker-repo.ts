import { isoNow } from "../../lib/time.js";
import { newId } from "../../lib/ids.js";
import type { WorkerRepo } from "../worker-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";
import type { WorkerRecord } from "../records.js";

const mapWorker = (row: SqliteRow): WorkerRecord => ({
  id: String(row.id),
  slot: Number(row.slot),
  status: row.status as WorkerRecord["status"],
  currentAttemptId: (row.current_attempt_id as string | null) ?? null,
  lastHeartbeatAt: String(row.last_heartbeat_at),
});

export class SqliteWorkerRepo implements WorkerRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  ensureWorkerSlots(concurrency: number): void {
    const now = isoNow();
    const insert = this.sqlite.prepare(
      "INSERT INTO worker(id, slot, status, process_id, current_attempt_id, started_at, last_heartbeat_at, updated_at) VALUES (?, ?, 'idle', NULL, NULL, ?, ?, ?)",
    );
    const existing = new Set(
      this.sqlite
        .prepare("SELECT slot FROM worker")
        .all()
        .map((row: unknown) => Number((row as SqliteRow).slot)),
    );

    this.sqlite.transaction(() => {
      for (let slot = 1; slot <= concurrency; slot += 1) {
        if (!existing.has(slot)) {
          insert.run(newId(), slot, now, now, now);
        }
      }
    })();
  }

  listWorkers(): WorkerRecord[] {
    return this.sqlite
      .prepare("SELECT id, slot, status, current_attempt_id, last_heartbeat_at FROM worker ORDER BY slot ASC")
      .all()
      .map((row: unknown) => mapWorker(row as SqliteRow));
  }

  updateWorkerStatus(workerId: string, status: WorkerRecord["status"], currentAttemptId: string | null): void {
    this.sqlite
      .prepare(
        "UPDATE worker SET status = ?, current_attempt_id = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, currentAttemptId, isoNow(), isoNow(), workerId);
  }

  heartbeatWorker(workerId: string, attemptId: string | null, expiresAt: string): void {
    const now = isoNow();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("UPDATE worker SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(now, now, workerId);

      if (attemptId) {
        this.sqlite
          .prepare(
            "UPDATE lease SET heartbeat_at = ?, expires_at = ? WHERE worker_id = ? AND execution_attempt_id = ? AND released_at IS NULL",
          )
          .run(now, expiresAt, workerId, attemptId);
      }
    })();
  }
}
