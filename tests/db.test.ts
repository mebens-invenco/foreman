import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { priorityToRank } from "../src/db.js";
import { addSeconds } from "../src/lib/time.js";
import { createMigratedDb, createTempDir } from "./helpers.js";

const cleanupDirs: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ForemanDb leases", () => {
  test("creates attempt-owned leases that heartbeat and release by attempt", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.ensureWorkerSlots(1);
      const worker = db.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.createJob({
        taskId: "TASK-0001",
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0001:execution",
        selectionReason: "test",
      });

      const attempt = db.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [
          { resourceType: "task", resourceKey: "TASK-0001" },
          { resourceType: "branch", resourceKey: "repo-a:task-0001" },
        ],
      });

      expect(attempt).not.toBeNull();

      const createdLeases = db.sqlite
        .prepare(
          "SELECT execution_attempt_id, released_at FROM lease WHERE worker_id = ? ORDER BY resource_key ASC",
        )
        .all(worker!.id) as Array<{ execution_attempt_id: string; released_at: string | null }>;
      expect(createdLeases).toHaveLength(2);
      expect(createdLeases.every((lease) => lease.execution_attempt_id === attempt!.id)).toBe(true);

      const nextExpiry = addSeconds(new Date(), 240);
      db.heartbeatWorker(worker!.id, attempt!.id, nextExpiry);

      const heartbeatedLeases = db.sqlite
        .prepare("SELECT expires_at FROM lease WHERE execution_attempt_id = ? AND released_at IS NULL")
        .all(attempt!.id) as Array<{ expires_at: string }>;
      expect(heartbeatedLeases).toHaveLength(2);
      expect(heartbeatedLeases.every((lease) => lease.expires_at === nextExpiry)).toBe(true);

      db.releaseLeasesForAttempt(attempt!.id, "completed");

      const releasedLeases = db.sqlite
        .prepare("SELECT release_reason FROM lease WHERE execution_attempt_id = ?")
        .all(attempt!.id) as Array<{ release_reason: string | null }>;
      expect(releasedLeases.every((lease) => lease.release_reason === "completed")).toBe(true);
      expect(db.hasActiveTaskLease("TASK-0001")).toBe(false);
    } finally {
      db.close();
    }
  });
});
