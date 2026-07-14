import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import type { Task } from "../../domain/index.js";
import { createMigratedDb, createTempDir, seedExecutionAttempt, testProjectRoot } from "../../test-support/helpers.js";
import type { ForemanRepos, LearningUsageRollup } from "../index.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

const taskNamed = (id: string): Task => ({
  id,
  provider: "file",
  providerId: id,
  title: `task ${id}`,
  description: "",
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "foreman", branchName: id.toLowerCase(), position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-07-14T00:00:00Z",
  url: null,
});

const TASK_A = taskNamed("ENG-A");
const TASK_B = taskNamed("ENG-B");

/** No source task: written before provenance existed, so it has no self to echo. */
const ORPHAN = "learn-orphan";
/** Extracted by TASK_A, so TASK_A using it is the self-echo. */
const SELF_SOURCED = "learn-from-task-a";

const seedLearnings = (db: Db): void => {
  db.learnings.addLearning({ id: ORPHAN, title: "Orphan", repo: "shared", confidence: "emerging", content: "c", tags: [] });
  db.learnings.addLearning({
    id: SELF_SOURCED,
    title: "Self sourced",
    repo: "shared",
    confidence: "emerging",
    content: "c",
    tags: [],
    sourceTaskId: TASK_A.id,
  });
};

/**
 * One search a stage of `task` ran, hitting `learningIds`. A stage is its own
 * attempt, which is the whole point: three stages of one task are three attempts
 * and three read events, and must still collapse to one distinct task.
 */
const searchIn = (db: Db, input: { task: Task; learningIds: string[] }): void => {
  const attempt = seedExecutionAttempt(db, { task: input.task, repoKey: "foreman", action: "execution" });
  db.learnings.getLearningsByIds(input.learningIds, { incrementReadCount: true });
  db.learningSearchEvents.recordEvent({
    kind: "search",
    queries: ["how do I"],
    hitIds: input.learningIds,
    source: { attemptId: attempt.id, taskId: input.task.id },
  });
};

/** A human at a terminal: no attempt, so no task can be attributed to the read. */
const searchAdHoc = (db: Db, learningIds: string[]): void => {
  db.learnings.getLearningsByIds(learningIds, { incrementReadCount: true });
  db.learningSearchEvents.recordEvent({ kind: "search", queries: ["how do I"], hitIds: learningIds });
};

const applyIn = (db: Db, input: { task: Task; learningId: string }): void => {
  const attempt = seedExecutionAttempt(db, { task: input.task, repoKey: "foreman", action: "execution" });
  db.learnings.updateLearning({ id: input.learningId, markApplied: true });
  db.learningUsage.recordApplied({
    attemptId: attempt.id,
    taskId: input.task.id,
    action: "execution",
    learningId: input.learningId,
  });
};

const rollupFor = (db: ForemanRepos, learningId: string): LearningUsageRollup | undefined =>
  db.learningUsage.getUsageStats().learnings.find((learning) => learning.learningId === learningId);

const withDb = async (run: (db: Db) => Promise<void> | void): Promise<void> => {
  const workspaceRoot = await createTempDir("foreman-learning-usage-");
  cleanupDirs.push(workspaceRoot);
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
  try {
    seedLearnings(db);
    await run(db);
  } finally {
    db.close();
  }
};

describe("learning usage stats", () => {
  describe("when one task's stages each search the same learning", () => {
    test("pipeline depth collapses to one distinct task, and the raw counter still shows the depth", async () => {
      await withDb((db) => {
        for (let stage = 0; stage < 3; stage += 1) {
          searchIn(db, { task: TASK_A, learningIds: [ORPHAN] });
        }

        expect(rollupFor(db, ORPHAN)).toMatchObject({
          learningId: ORPHAN,
          distinctTasksRead: 1,
          readCount: 3,
          selfEchoReads: 0,
        });
      });
    });
  });

  describe("when two stages of one task each mark the same learning applied", () => {
    test("the applies collapse to one distinct task", async () => {
      await withDb((db) => {
        applyIn(db, { task: TASK_A, learningId: ORPHAN });
        applyIn(db, { task: TASK_A, learningId: ORPHAN });

        expect(rollupFor(db, ORPHAN)).toMatchObject({
          distinctTasksApplied: 1,
          appliedCount: 2,
          selfEchoApplies: 0,
        });
      });
    });
  });

  describe("when separate tasks use the same learning", () => {
    test("each one raises the distinct-task count, which is the signal promotion wants", async () => {
      await withDb((db) => {
        searchIn(db, { task: TASK_A, learningIds: [ORPHAN] });
        searchIn(db, { task: TASK_B, learningIds: [ORPHAN] });
        applyIn(db, { task: TASK_A, learningId: ORPHAN });
        applyIn(db, { task: TASK_B, learningId: ORPHAN });

        expect(rollupFor(db, ORPHAN)).toMatchObject({ distinctTasksRead: 2, distinctTasksApplied: 2 });
      });
    });
  });

  describe("when a task uses the learning it extracted itself", () => {
    test("the self-echo is excluded from both distinct-task counts and reported as an echo", async () => {
      await withDb((db) => {
        searchIn(db, { task: TASK_A, learningIds: [SELF_SOURCED] });
        applyIn(db, { task: TASK_A, learningId: SELF_SOURCED });

        expect(rollupFor(db, SELF_SOURCED)).toMatchObject({
          sourceTaskId: TASK_A.id,
          distinctTasksRead: 0,
          distinctTasksApplied: 0,
          selfEchoReads: 1,
          selfEchoApplies: 1,
        });
      });
    });

    test("a different task using it still counts, so the echo filter suppresses only the echo", async () => {
      await withDb((db) => {
        searchIn(db, { task: TASK_A, learningIds: [SELF_SOURCED] });
        searchIn(db, { task: TASK_B, learningIds: [SELF_SOURCED] });
        applyIn(db, { task: TASK_B, learningId: SELF_SOURCED });

        expect(rollupFor(db, SELF_SOURCED)).toMatchObject({
          distinctTasksRead: 1,
          distinctTasksApplied: 1,
          selfEchoReads: 1,
          selfEchoApplies: 0,
        });
      });
    });

    // Reads and applies are aggregated independently. Joined across both event
    // tables, these 3 reads and 2 applies would fan out to 6 rows and BOTH echo
    // counts would come back as 6.
    test("the echo event counts are not multiplied by the other side's row count", async () => {
      await withDb((db) => {
        for (let stage = 0; stage < 3; stage += 1) {
          searchIn(db, { task: TASK_A, learningIds: [SELF_SOURCED] });
        }
        applyIn(db, { task: TASK_A, learningId: SELF_SOURCED });
        applyIn(db, { task: TASK_A, learningId: SELF_SOURCED });

        expect(rollupFor(db, SELF_SOURCED)).toMatchObject({ selfEchoReads: 3, selfEchoApplies: 2 });
      });
    });
  });

  // `task_id <> NULL` is NULL, not true, in SQL's three-valued logic: expressed as
  // a bare inequality the echo filter would drop every read of every learning
  // written before provenance existed -- which is most of the corpus.
  describe("when the learning has no source task", () => {
    test("its reads and applies still count, because it has no self to echo", async () => {
      await withDb((db) => {
        searchIn(db, { task: TASK_A, learningIds: [ORPHAN] });
        applyIn(db, { task: TASK_A, learningId: ORPHAN });

        expect(rollupFor(db, ORPHAN)).toMatchObject({
          sourceTaskId: null,
          distinctTasksRead: 1,
          distinctTasksApplied: 1,
          selfEchoReads: 0,
          selfEchoApplies: 0,
        });
      });
    });
  });

  describe("when a human runs the CLI outside any attempt", () => {
    test("the read stamps no task, stays out of the distinct counts, and is reported as unattributed", async () => {
      await withDb((db) => {
        searchAdHoc(db, [ORPHAN]);

        const [event] = db.learningSearchEvents.listEvents();
        expect(event).toMatchObject({ attemptId: null, taskId: null });

        const stats = db.learningUsage.getUsageStats();
        expect(stats.unattributedReadEvents).toBe(1);
        // Read once by the ad-hoc query, but by no task -- so it is not in the rollup at all.
        expect(stats.learnings).toHaveLength(0);
      });
    });

    test("it does not dilute a learning a real task also read", async () => {
      await withDb((db) => {
        searchIn(db, { task: TASK_A, learningIds: [ORPHAN] });
        searchAdHoc(db, [ORPHAN]);

        expect(rollupFor(db, ORPHAN)).toMatchObject({ distinctTasksRead: 1, readCount: 2 });
        expect(db.learningUsage.getUsageStats().unattributedReadEvents).toBe(1);
      });
    });
  });

  describe("when a learning is deleted", () => {
    test("its applied events cascade away with it", async () => {
      await withDb((db) => {
        applyIn(db, { task: TASK_A, learningId: ORPHAN });
        expect(db.database.sqlite.prepare("SELECT COUNT(*) AS count FROM learning_applied_event").get()).toMatchObject({
          count: 1,
        });

        db.database.sqlite.prepare("DELETE FROM learning WHERE id = ?").run(ORPHAN);

        expect(db.database.sqlite.prepare("SELECT COUNT(*) AS count FROM learning_applied_event").get()).toMatchObject({
          count: 0,
        });
      });
    });
  });

  describe("when a --since window is given", () => {
    test("usage recorded before it is excluded", async () => {
      await withDb((db) => {
        searchIn(db, { task: TASK_A, learningIds: [ORPHAN] });
        applyIn(db, { task: TASK_A, learningId: ORPHAN });

        const future = "2099-01-01T00:00:00.000Z";
        expect(db.learningUsage.getUsageStats({ since: future })).toMatchObject({
          learnings: [],
          unattributedReadEvents: 0,
        });
      });
    });
  });
});
