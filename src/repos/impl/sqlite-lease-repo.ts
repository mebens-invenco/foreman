import { isoNow } from "../../lib/time.js";
import { newId } from "../../lib/ids.js";
import type { LeaseRepo, LeaseResourceType } from "../lease-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

export class SqliteLeaseRepo implements LeaseRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  acquireLease(input: {
    resourceType: LeaseResourceType;
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

  releaseLeaseByResource(resourceType: LeaseResourceType, resourceKey: string, reason: string): void {
    this.sqlite
      .prepare(
        "UPDATE lease SET released_at = ?, release_reason = ? WHERE resource_type = ? AND resource_key = ? AND released_at IS NULL",
      )
      .run(isoNow(), reason, resourceType, resourceKey);
  }

  hasActiveTaskLease(taskId: string): boolean {
    const row = this.sqlite
      .prepare("SELECT 1 AS present FROM lease WHERE resource_type = 'task' AND resource_key = ? AND released_at IS NULL LIMIT 1")
      .get(taskId) as SqliteRow | undefined;
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
}
