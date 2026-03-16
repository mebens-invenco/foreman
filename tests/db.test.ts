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

  test("recovers orphaned running attempts without active leases", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.ensureWorkerSlots(1);
      const worker = db.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.createJob({
        taskId: "TASK-0002",
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0002:execution",
        selectionReason: "test",
      });
      const attempt = db.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [{ resourceType: "task", resourceKey: "TASK-0002" }],
      });

      expect(attempt).not.toBeNull();
      db.updateWorkerStatus(worker!.id, "running", attempt!.id);
      db.updateJobStatus(job.id, "running", { startedAt: attempt!.startedAt });
      db.releaseLeasesForAttempt(attempt!.id, "expired");

      const recovered = db.recoverOrphanedRunningAttempts("Recovered abandoned attempt on scheduler startup after prior shutdown");
      expect(recovered).toEqual([{ attemptId: attempt!.id, jobId: job.id, workerId: worker!.id }]);

      expect(db.getAttempt(attempt!.id).status).toBe("canceled");
      expect(db.getJob(job.id).status).toBe("canceled");
      expect(db.listWorkers()[0]?.status).toBe("idle");
      expect(db.listWorkers()[0]?.currentAttemptId).toBeNull();

      const events = db.listAttemptEvents(attempt!.id);
      expect(events.some((event) => event.eventType === "attempt_recovered")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("claims queued jobs for idle workers atomically", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.ensureWorkerSlots(1);
      const worker = db.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.createJob({
        taskId: "TASK-0003",
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0003:execution",
        selectionReason: "test",
      });

      expect(db.claimQueuedJobForWorker(job.id, worker!.id)).toBe(true);
      expect(db.claimQueuedJobForWorker(job.id, worker!.id)).toBe(false);

      expect(db.getJob(job.id).status).toBe("leased");
      expect(db.listWorkers()[0]?.status).toBe("leased");

      db.returnLeasedJobToQueue(job.id);

      expect(db.getJob(job.id).status).toBe("queued");
      expect(db.getJob(job.id).leasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  test("upserts review checkpoints without changing row identity", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      const taskId = "TASK-0004";
      const prUrl = "https://github.com/acme/repo/pull/123";
      db.ensureWorkerSlots(1);
      const worker = db.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.createJob({
        taskId,
        taskProvider: "file",
        action: "review",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${taskId}:review`,
        selectionReason: "test",
      });

      const attemptOne = db.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [],
      });
      const attemptTwo = db.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 240),
        leases: [],
      });

      expect(attemptOne).not.toBeNull();
      expect(attemptTwo).not.toBeNull();

      db.upsertReviewCheckpoint({
        taskId,
        prUrl,
        sourceAttemptId: attemptOne!.id,
        reviewContext: {
          provider: "github",
          pullRequestUrl: prUrl,
          pullRequestNumber: 123,
          state: "open",
          isDraft: false,
          headSha: "sha-1",
          headBranch: "feature/task-0004",
          baseBranch: "main",
          headIntroducedAt: "2026-03-16T00:00:00Z",
          mergeState: "clean",
          actionableReviewSummaries: [{ id: "review-1", body: "Needs work", authorName: "reviewer", createdAt: "2026-03-16T00:00:00Z", commitId: "sha-1" }],
          actionableConversationComments: [{ id: "comment-1", body: "Please fix", authorName: "reviewer", createdAt: "2026-03-16T00:00:01Z" }],
          unresolvedThreads: [],
          failingChecks: [{ name: "test", state: "failure" }],
          pendingChecks: [{ name: "lint", state: "pending" }],
        },
      });

      const firstCheckpoint = db.getReviewCheckpoint(taskId, prUrl) as Record<string, unknown>;
      expect(firstCheckpoint).not.toBeNull();
      expect(firstCheckpoint.id).toBeDefined();
      expect(firstCheckpoint.head_sha).toBe("sha-1");
      expect(firstCheckpoint.source_attempt_id).toBe(attemptOne!.id);

      db.upsertReviewCheckpoint({
        taskId,
        prUrl,
        sourceAttemptId: attemptTwo!.id,
        reviewContext: {
          provider: "github",
          pullRequestUrl: prUrl,
          pullRequestNumber: 123,
          state: "open",
          isDraft: false,
          headSha: "sha-2",
          headBranch: "feature/task-0004",
          baseBranch: "main",
          headIntroducedAt: "2026-03-16T00:05:00Z",
          mergeState: "dirty",
          actionableReviewSummaries: [],
          actionableConversationComments: [],
          unresolvedThreads: [],
          failingChecks: [],
          pendingChecks: [],
        },
      });

      const secondCheckpoint = db.getReviewCheckpoint(taskId, prUrl) as Record<string, unknown>;
      expect(secondCheckpoint.id).toBe(firstCheckpoint.id);
      expect(secondCheckpoint.head_sha).toBe("sha-2");
      expect(secondCheckpoint.merge_state).toBe("dirty");
      expect(secondCheckpoint.latest_review_summary_id).toBeNull();
      expect(secondCheckpoint.latest_conversation_comment_id).toBeNull();
      expect(secondCheckpoint.source_attempt_id).toBe(attemptTwo!.id);

      const rowCount = db.sqlite
        .prepare("SELECT COUNT(*) AS count FROM review_checkpoint WHERE task_id = ? AND pr_url = ?")
        .get(taskId, prUrl) as { count: number };
      expect(rowCount.count).toBe(1);
    } finally {
      db.close();
    }
  });
});
