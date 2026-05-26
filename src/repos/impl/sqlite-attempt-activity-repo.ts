import { newId } from "../../lib/ids.js";
import { stableStringify } from "../../lib/json.js";
import { isoNow } from "../../lib/time.js";
import {
  isAttemptActivityKind,
  type AppendActivityInput,
  type AttemptActivityKind,
  type AttemptActivityRecord,
  type AttemptActivityRepo,
  type ListActivitiesOptions,
} from "../attempt-activity-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const mapActivity = (row: SqliteRow): AttemptActivityRecord => {
  const rawKind = String(row.kind);
  const kind: AttemptActivityKind = isAttemptActivityKind(rawKind) ? rawKind : "unknown";
  return {
    id: String(row.id),
    executionAttemptId: String(row.execution_attempt_id),
    seq: Number(row.seq),
    kind,
    message: String(row.message ?? ""),
    payload: JSON.parse(String(row.payload_json ?? "{}")),
    createdAt: String(row.created_at),
  };
};

export class SqliteAttemptActivityRepo implements AttemptActivityRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  appendActivity(input: AppendActivityInput): AttemptActivityRecord {
    const record: AttemptActivityRecord = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM execution_attempt_activity WHERE execution_attempt_id = ?",
        )
        .get(input.executionAttemptId) as SqliteRow;
      const nextSeq = Number(row.max_seq ?? 0) + 1;

      const created: AttemptActivityRecord = {
        id: newId(),
        executionAttemptId: input.executionAttemptId,
        seq: nextSeq,
        kind: input.kind,
        message: input.message ?? "",
        payload: input.payload ?? {},
        createdAt: isoNow(),
      };

      this.sqlite
        .prepare(
          `INSERT INTO execution_attempt_activity(
            id, execution_attempt_id, seq, kind, message, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          created.id,
          created.executionAttemptId,
          created.seq,
          created.kind,
          created.message,
          stableStringify(created.payload),
          created.createdAt,
        );

      return created;
    })();

    return record;
  }

  listActivities(executionAttemptId: string, options: ListActivitiesOptions = {}): AttemptActivityRecord[] {
    const conditions: string[] = ["execution_attempt_id = ?"];
    const params: unknown[] = [executionAttemptId];

    if (options.afterSeq !== undefined) {
      conditions.push("seq > ?");
      params.push(options.afterSeq);
    }

    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map(() => "?").join(", ");
      conditions.push(`kind IN (${placeholders})`);
      params.push(...options.kinds);
    }

    const limitClause = options.limit !== undefined ? " LIMIT ?" : "";
    if (options.limit !== undefined) {
      params.push(options.limit);
    }

    return this.sqlite
      .prepare(
        `SELECT id, execution_attempt_id, seq, kind, message, payload_json, created_at
           FROM execution_attempt_activity
          WHERE ${conditions.join(" AND ")}
          ORDER BY seq ASC${limitClause}`,
      )
      .all(...params)
      .map((row: unknown) => mapActivity(row as SqliteRow));
  }

  latestActivity(executionAttemptId: string): AttemptActivityRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, execution_attempt_id, seq, kind, message, payload_json, created_at
           FROM execution_attempt_activity
          WHERE execution_attempt_id = ?
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(executionAttemptId) as SqliteRow | undefined;

    return row ? mapActivity(row) : null;
  }

  latestActivityOfKind(executionAttemptId: string, kind: AttemptActivityKind): AttemptActivityRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, execution_attempt_id, seq, kind, message, payload_json, created_at
           FROM execution_attempt_activity
          WHERE execution_attempt_id = ?
            AND kind = ?
          ORDER BY seq DESC
          LIMIT 1`,
      )
      .get(executionAttemptId, kind) as SqliteRow | undefined;

    return row ? mapActivity(row) : null;
  }

  countActivities(executionAttemptId: string, options: { kind?: AttemptActivityKind } = {}): number {
    if (options.kind) {
      const row = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM execution_attempt_activity
            WHERE execution_attempt_id = ?
              AND kind = ?`,
        )
        .get(executionAttemptId, options.kind) as { count: number };
      return Number(row.count ?? 0);
    }

    const row = this.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM execution_attempt_activity WHERE execution_attempt_id = ?",
      )
      .get(executionAttemptId) as { count: number };
    return Number(row.count ?? 0);
  }

  trimRetention(executionAttemptId: string, maxRows: number): number {
    if (maxRows < 0) {
      return 0;
    }

    const result = this.sqlite
      .prepare(
        `DELETE FROM execution_attempt_activity
          WHERE execution_attempt_id = ?
            AND seq <= (
              SELECT seq FROM execution_attempt_activity
               WHERE execution_attempt_id = ?
               ORDER BY seq DESC
               LIMIT 1 OFFSET ?
            )`,
      )
      .run(executionAttemptId, executionAttemptId, maxRows);

    return Number(result.changes ?? 0);
  }
}
