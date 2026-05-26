import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { priorityToRank } from "../../domain/index.js";
import { addSeconds } from "../../lib/time.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const seedAttempt = async () => {
  const tempDir = await createTempDir("foreman-attempt-activity-test-");
  cleanupDirs.push(tempDir);
  const db = await createMigratedDb(path.join(tempDir, "foreman.db"), testProjectRoot);

  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0]!;

  db.taskMirror.saveTasks([
    {
      id: "TASK-ACT",
      provider: "file",
      providerId: "TASK-ACT",
      title: "Activity task",
      description: "",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      labels: ["Agent"],
      assignee: null,
      targets: [{ repoKey: "repo-a", branchName: "task-act", position: 0 }],
      targetDependencies: [],
      dependencies: { taskIds: [], baseTaskId: null },
      baseBranch: null,
      pullRequests: [],
      updatedAt: "2026-05-26T00:00:00Z",
      url: null,
    },
  ]);
  const target = db.taskMirror.getTaskTarget("TASK-ACT", "repo-a")!;
  const job = db.jobs.createJob({
    taskId: "TASK-ACT",
    taskTargetId: target.id,
    taskProvider: "file",
    action: "execution",
    priorityRank: priorityToRank("high"),
    repoKey: "repo-a",
    baseBranch: "main",
    dedupeKey: "TASK-ACT:execution",
    selectionReason: "test",
  });
  const attempt = db.attempts.createAttemptWithLeases({
    jobId: job.id,
    workerId: worker.id,
    runnerName: "codex",
    runnerModel: "gpt-5.5",
    runnerVariant: "high",
    expiresAt: addSeconds(new Date(), 120),
    leases: [{ resourceType: "task", resourceKey: "TASK-ACT" }],
  })!;

  return { db, attemptId: attempt.id };
};

describe("AttemptActivityRepo", () => {
  test("appends activities with monotonic per-attempt seq and lists by afterSeq", async () => {
    const { db, attemptId } = await seedAttempt();
    try {
      const first = db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "assistant_message",
        message: "first",
        payload: { idx: 1 },
      });
      const second = db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "command_started",
        message: "second",
      });
      const third = db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "command_finished",
        message: "third",
      });

      expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
      expect(first.payload).toEqual({ idx: 1 });
      expect(db.attemptActivities.countActivities(attemptId)).toBe(3);

      const afterFirst = db.attemptActivities.listActivities(attemptId, { afterSeq: 1 });
      expect(afterFirst.map((row) => row.seq)).toEqual([2, 3]);

      expect(db.attemptActivities.latestActivity(attemptId)?.seq).toBe(3);
      expect(db.attemptActivities.latestActivityOfKind(attemptId, "assistant_message")?.message).toBe("first");
    } finally {
      db.close();
    }
  });

  test("filters list by kinds", async () => {
    const { db, attemptId } = await seedAttempt();
    try {
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "command_started" });
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "command_finished" });
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message" });

      const finishes = db.attemptActivities.listActivities(attemptId, { kinds: ["command_finished"] });
      expect(finishes.map((row) => row.kind)).toEqual(["command_finished"]);
    } finally {
      db.close();
    }
  });

  test("trims to maxRows by removing the oldest seq values", async () => {
    const { db, attemptId } = await seedAttempt();
    try {
      for (let idx = 1; idx <= 6; idx += 1) {
        db.attemptActivities.appendActivity({
          executionAttemptId: attemptId,
          kind: "progress",
          message: `row-${idx}`,
        });
      }
      expect(db.attemptActivities.countActivities(attemptId)).toBe(6);

      const removed = db.attemptActivities.trimRetention(attemptId, 3);
      expect(removed).toBe(3);
      const remaining = db.attemptActivities.listActivities(attemptId);
      expect(remaining.map((row) => row.seq)).toEqual([4, 5, 6]);
    } finally {
      db.close();
    }
  });

  test("recordAttemptMilestone routes to writeTo targets explicitly", async () => {
    const { db, attemptId } = await seedAttempt();
    try {
      db.attempts.recordAttemptMilestone(
        attemptId,
        "attempt_started",
        "Started execution for TASK-ACT",
        { taskId: "TASK-ACT", action: "execution" },
        { writeTo: ["event", "activity"] },
      );
      db.attempts.recordAttemptMilestone(
        attemptId,
        "event_only_milestone",
        "Recorded audit only",
        { detail: "audit" },
        { writeTo: ["event"] },
      );
      db.attempts.recordAttemptMilestone(
        attemptId,
        "activity_only_milestone",
        "Visible in live feed",
        { detail: "live" },
        { writeTo: ["activity"] },
      );

      const events = db.attempts.listAttemptEvents(attemptId);
      expect(events.map((event) => event.eventType)).toEqual([
        "attempt_started",
        "event_only_milestone",
      ]);

      const activities = db.attemptActivities.listActivities(attemptId);
      expect(activities.map((row) => row.payload.name)).toEqual([
        "attempt_started",
        "activity_only_milestone",
      ]);
      expect(activities.every((row) => row.kind === "foreman_milestone")).toBe(true);

      expect(() =>
        db.attempts.recordAttemptMilestone(attemptId, "bad", "", {}, { writeTo: [] }),
      ).toThrow(/writeTo/);
    } finally {
      db.close();
    }
  });
});
