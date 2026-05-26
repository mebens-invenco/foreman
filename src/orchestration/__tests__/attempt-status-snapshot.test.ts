import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { priorityToRank } from "../../domain/index.js";
import { addSeconds } from "../../lib/time.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { buildAttemptStatusSnapshot } from "../attempt-status-snapshot.js";

type SeededDb = Awaited<ReturnType<typeof createMigratedDb>>;

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const setupAttempt = async (overrides: { startedAtIso?: string } = {}) => {
  const tempDir = await createTempDir("foreman-attempt-snapshot-test-");
  cleanupDirs.push(tempDir);
  const db = await createMigratedDb(path.join(tempDir, "foreman.db"), testProjectRoot);

  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0]!;

  db.taskMirror.saveTasks([
    {
      id: "TASK-SNAP",
      provider: "file",
      providerId: "TASK-SNAP",
      title: "Snapshot task",
      description: "",
      state: "ready",
      providerState: "ready",
      priority: "high",
      labels: ["Agent"],
      assignee: null,
      targets: [{ repoKey: "repo-a", branchName: "task-snap", position: 0 }],
      targetDependencies: [],
      dependencies: { taskIds: [], baseTaskId: null },
      baseBranch: null,
      pullRequests: [],
      updatedAt: "2026-05-26T00:00:00Z",
      url: null,
    },
  ]);
  const target = db.taskMirror.getTaskTarget("TASK-SNAP", "repo-a")!;
  const job = db.jobs.createJob({
    taskId: "TASK-SNAP",
    taskTargetId: target.id,
    taskProvider: "file",
    action: "execution",
    priorityRank: priorityToRank("high"),
    repoKey: "repo-a",
    baseBranch: "main",
    dedupeKey: "TASK-SNAP:execution",
    selectionReason: "test",
  });

  const attempt = db.attempts.createAttemptWithLeases({
    jobId: job.id,
    workerId: worker.id,
    runnerName: "codex",
    runnerModel: "gpt-5.5",
    runnerVariant: "high",
    expiresAt: addSeconds(new Date(), 600),
    leases: [{ resourceType: "task", resourceKey: "TASK-SNAP" }],
  })!;

  db.workers.updateWorkerStatus(worker.id, "running", attempt.id);
  db.jobs.updateJobStatus(job.id, "running", { startedAt: attempt.startedAt });

  if (overrides.startedAtIso) {
    db.database.sqlite
      .prepare("UPDATE execution_attempt SET started_at = ? WHERE id = ?")
      .run(overrides.startedAtIso, attempt.id);
  }

  return { db, attemptId: attempt.id };
};

const ageActivities = (db: SeededDb, attemptId: string, iso: string): void => {
  db.database.sqlite
    .prepare("UPDATE execution_attempt_activity SET created_at = ? WHERE execution_attempt_id = ?")
    .run(iso, attemptId);
};

const setLatestActivityCreatedAt = (db: SeededDb, attemptId: string, iso: string): void => {
  db.database.sqlite
    .prepare(
      `UPDATE execution_attempt_activity
          SET created_at = ?
        WHERE execution_attempt_id = ?
          AND seq = (SELECT MAX(seq) FROM execution_attempt_activity WHERE execution_attempt_id = ?)`,
    )
    .run(iso, attemptId, attemptId);
};

describe("buildAttemptStatusSnapshot", () => {
  test("progressing: returns progressing phase with current operation and counts", async () => {
    const { db, attemptId } = await setupAttempt();
    try {
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "Plan ready" });
      db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "command_started",
        message: "yarn test",
        payload: { itemType: "command_execution", command: "yarn test" },
      });

      const snapshot = buildAttemptStatusSnapshot(db, attemptId);

      expect(snapshot.phase).toBe("progressing");
      expect(snapshot.currentOperation).toMatchObject({ kind: "command_started", message: "yarn test" });
      expect(snapshot.counts.assistantMessages).toBe(1);
      expect(snapshot.counts.commands).toBe(1);
      expect(snapshot.progressSummary.latestMeaningfulMessage).toBe("Plan ready");
      expect(snapshot.stuck.isStuck).toBe(false);
      expect(snapshot.needsHuman.isNeeded).toBe(false);
    } finally {
      db.close();
    }
  });

  test("suspicious: errors push the phase to suspicious without crossing the needs-human threshold", async () => {
    const { db, attemptId } = await setupAttempt();
    try {
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "Try again" });
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "error", message: "test failure" });

      const snapshot = buildAttemptStatusSnapshot(db, attemptId);
      expect(snapshot.phase).toBe("suspicious");
      expect(snapshot.counts.errors).toBe(1);
      expect(snapshot.needsHuman.isNeeded).toBe(false);
    } finally {
      db.close();
    }
  });

  test("stuck (no progress): meaningful activity older than threshold marks stuck=no_progress", async () => {
    const { db, attemptId } = await setupAttempt();
    try {
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "Meaningful row" });
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "reasoning", message: "Quiet thinking" });

      const now = new Date("2026-05-26T01:00:00Z");
      ageActivities(db, attemptId, "2026-05-26T00:54:00Z"); // 6 min ago: latest activity still recent
      setLatestActivityCreatedAt(db, attemptId, "2026-05-26T00:59:30Z"); // 30s ago — not stuck for no_activity

      const snapshot = buildAttemptStatusSnapshot(db, attemptId, {
        now,
        stuckNoProgressSeconds: 300,
        stuckNoActivitySeconds: 600,
      });
      expect(snapshot.phase).toBe("stuck");
      expect(snapshot.stuck.reason).toBe("no_progress");
      expect(snapshot.stuck.sinceSeconds ?? 0).toBeGreaterThanOrEqual(300);
    } finally {
      db.close();
    }
  });

  test("stuck (no activity): zero activity rows after threshold", async () => {
    const { db, attemptId } = await setupAttempt({ startedAtIso: "2026-05-26T00:50:00Z" });
    try {
      const snapshot = buildAttemptStatusSnapshot(db, attemptId, {
        now: new Date("2026-05-26T01:00:00Z"),
        stuckNoActivitySeconds: 120,
      });
      expect(snapshot.phase).toBe("stuck");
      expect(snapshot.stuck.reason).toBe("no_activity");
      expect(snapshot.stuck.sinceSeconds ?? 0).toBeGreaterThanOrEqual(120);
    } finally {
      db.close();
    }
  });

  test("finished: attempt status drives the finished phase regardless of activity recency", async () => {
    const { db, attemptId } = await setupAttempt();
    try {
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "Done" });
      db.attempts.finalizeAttempt(attemptId, "completed", { finishedAt: "2026-05-26T01:00:00Z", summary: "ok" });

      const snapshot = buildAttemptStatusSnapshot(db, attemptId, { now: new Date("2026-05-26T05:00:00Z") });
      expect(snapshot.phase).toBe("finished");
      expect(snapshot.stuck.isStuck).toBe(false);
    } finally {
      db.close();
    }
  });

  test("unknown: with no activities and recent start the snapshot is in 'starting'", async () => {
    const { db, attemptId } = await setupAttempt();
    try {
      const snapshot = buildAttemptStatusSnapshot(db, attemptId, { now: new Date() });
      expect(snapshot.phase).toBe("starting");
      expect(snapshot.currentOperation).toBeNull();
      expect(snapshot.counts.activities).toBe(0);
    } finally {
      db.close();
    }
  });

  test("repeated command failures push needsHuman and surface candidates", async () => {
    const { db, attemptId } = await setupAttempt();
    try {
      for (let idx = 0; idx < 3; idx += 1) {
        db.attemptActivities.appendActivity({
          executionAttemptId: attemptId,
          kind: "command_finished",
          message: "yarn test",
          payload: { itemType: "command_execution", command: "yarn test", exit_code: 1 },
        });
      }

      const snapshot = buildAttemptStatusSnapshot(db, attemptId, { repeatedFailureWindow: 3 });
      expect(snapshot.repeatedFailureCandidates).toHaveLength(1);
      expect(snapshot.repeatedFailureCandidates[0]?.count).toBe(3);
      expect(snapshot.needsHuman.isNeeded).toBe(true);
      expect(snapshot.needsHuman.reasons).toContain("repeated_command_failure");
      expect(snapshot.phase).toBe("needs_human");
    } finally {
      db.close();
    }
  });

  test("explicit needs-human milestone flips needsHuman regardless of failure window", async () => {
    const { db, attemptId } = await setupAttempt();
    try {
      db.attempts.recordAttemptMilestone(
        attemptId,
        "blocked_on_question",
        "Please clarify constraints",
        { needsHuman: true },
        { writeTo: ["event", "activity"] },
      );

      const snapshot = buildAttemptStatusSnapshot(db, attemptId);
      expect(snapshot.needsHuman.isNeeded).toBe(true);
      expect(snapshot.needsHuman.reasons.some((reason) => reason.startsWith("milestone:"))).toBe(true);
      expect(snapshot.phase).toBe("needs_human");
    } finally {
      db.close();
    }
  });
});
