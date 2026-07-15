import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import type { Task } from "../../domain/index.js";
import { proposeConfidenceTransitions } from "../../curation/confidence-lifecycle.js";
import { createMigratedDb, createTempDir, seedExecutionAttempt, testProjectRoot } from "../../test-support/helpers.js";
import type { ForemanRepos, LearningLifecycleRollup } from "../index.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

// The DB stamps every event at real wall-clock time, so the reference `now` and
// `epoch` are anchored to it: events seeded in a test read as recent, and only a
// deliberately backdated `created_at` reads as aged.
const DAY = 86_400_000;
const now = (): Date => new Date();
/** Old enough that the epoch grace never blocks the decay cases. */
const oldEpoch = (): Date => new Date(Date.now() - 200 * DAY);
const propose = (db: Db) => proposeConfidenceTransitions(db.learningUsage.getLifecycleRollups(), now(), oldEpoch());

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

const searchIn = (db: Db, input: { task: Task; learningId: string }): void => {
  const attempt = seedExecutionAttempt(db, { task: input.task, repoKey: "foreman", action: "execution" });
  db.learnings.getLearningsByIds([input.learningId], { incrementReadCount: true });
  db.learningSearchEvents.recordEvent({
    kind: "search",
    queries: ["how do I"],
    hitIds: [input.learningId],
    source: { attemptId: attempt.id, taskId: input.task.id },
  });
};

const applyIn = (db: Db, input: { task: Task; learningId: string }): void => {
  const attempt = seedExecutionAttempt(db, { task: input.task, repoKey: "foreman", action: "execution" });
  db.learnings.updateLearning({ id: input.learningId, markApplied: true });
  db.learningUsage.recordApplied({ attemptId: attempt.id, taskId: input.task.id, action: "execution", learningId: input.learningId });
};

const injectIn = (db: Db, input: { task: Task; learningId: string }): void => {
  const attempt = seedExecutionAttempt(db, { task: input.task, repoKey: "foreman", action: "execution" });
  db.learningInjectionEvents.recordInjection({
    attemptId: attempt.id,
    taskId: input.task.id,
    action: "execution",
    learnings: [{ learningId: input.learningId, rank: 1, cosineSimilarity: 0.9 }],
  });
};

const backdateCreatedAt = (db: Db, learningId: string, iso: string): void => {
  db.database.sqlite.prepare("UPDATE learning SET created_at = ? WHERE id = ?").run(iso, learningId);
};

const rollupFor = (db: ForemanRepos, learningId: string): LearningLifecycleRollup | undefined =>
  db.learningUsage.getLifecycleRollups().find((rollup) => rollup.learningId === learningId);

const withDb = async (run: (db: Db) => Promise<void> | void): Promise<void> => {
  const workspaceRoot = await createTempDir("foreman-lifecycle-rollup-");
  cleanupDirs.push(workspaceRoot);
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
  try {
    await run(db);
  } finally {
    db.close();
  }
};

describe("learning lifecycle rollups", () => {
  describe("when one task's pipeline stages inflate the raw counters", () => {
    // The end-to-end proof of the never-raw-counters invariant: raw applied_count
    // is 3 here, yet the rollup's distinct-task count is 1 and the pass proposes
    // nothing. A rule that read the raw counter would promote; this one cannot.
    test("the rollup reports distinct-task counts, and the pass refuses to promote on the inflated raw ones", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "inflated", title: "Inflated", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        for (let stage = 0; stage < 3; stage += 1) {
          searchIn(db, { task: TASK_A, learningId: "inflated" });
          applyIn(db, { task: TASK_A, learningId: "inflated" });
        }

        const raw = db.database.sqlite.prepare("SELECT read_count, applied_count FROM learning WHERE id = ?").get("inflated");
        expect(raw).toMatchObject({ read_count: 3, applied_count: 3 });

        expect(rollupFor(db, "inflated")).toMatchObject({ distinctTasksApplied: 1, distinctTasksRead: 1 });

        expect(propose(db).filter((proposal) => proposal.learningId === "inflated")).toEqual([]);
      });
    });
  });

  describe("when distinct tasks apply the same learning", () => {
    test("the distinct count crosses the threshold and the pass promotes it", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "earned", title: "Earned", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        applyIn(db, { task: TASK_A, learningId: "earned" });
        applyIn(db, { task: TASK_B, learningId: "earned" });

        expect(rollupFor(db, "earned")).toMatchObject({ distinctTasksApplied: 2 });

        expect(propose(db)).toMatchObject([{ kind: "promote", learningId: "earned", from: "emerging", to: "established" }]);
      });
    });
  });

  describe("recency for decay", () => {
    test("injection alone leaves lastUsedAt null; a genuine read sets it", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "pushed", title: "Pushed", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        injectIn(db, { task: TASK_A, learningId: "pushed" });

        // Being pushed at an agent is not being used — recency must ignore it.
        expect(rollupFor(db, "pushed")).toMatchObject({ lastUsedAt: null });

        searchIn(db, { task: TASK_B, learningId: "pushed" });
        expect(rollupFor(db, "pushed")!.lastUsedAt).not.toBeNull();
      });
    });

    test("an apply sets lastUsedAt", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "used", title: "Used", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        applyIn(db, { task: TASK_A, learningId: "used" });
        expect(rollupFor(db, "used")!.lastUsedAt).not.toBeNull();
      });
    });

    // Both sides non-null and distinct: laterIso must take the LATER of the read and
    // the apply. A wrong-direction combine would read an actively-used learning as
    // idle and silently archive it — a hole the single-side cases above cannot see.
    test("with a read and an apply at different times, lastUsedAt is the later of the two", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "both", title: "Both", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        applyIn(db, { task: TASK_A, learningId: "both" });
        searchIn(db, { task: TASK_B, learningId: "both" });

        // Pin distinct timestamps with the apply strictly later than the read.
        const readAt = new Date(Date.now() - 20 * DAY).toISOString();
        const applyAt = new Date(Date.now() - 5 * DAY).toISOString();
        db.database.sqlite.prepare("UPDATE learning_search_event SET created_at = ? WHERE hit_ids LIKE ?").run(readAt, "%both%");
        db.database.sqlite.prepare("UPDATE learning_applied_event SET created_at = ? WHERE learning_id = ?").run(applyAt, "both");

        expect(rollupFor(db, "both")!.lastUsedAt).toBe(applyAt);
      });
    });
  });

  describe("what the pass sees", () => {
    test("a never-touched learning is present with zero signal, so decay can reach it", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "untouched", title: "Untouched", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        expect(rollupFor(db, "untouched")).toMatchObject({ distinctTasksApplied: 0, distinctTasksRead: 0, lastUsedAt: null });
      });
    });

    test("an archived learning is out of the rollups entirely", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "shelved", title: "Shelved", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        db.learnings.archiveLearning("shelved");
        expect(rollupFor(db, "shelved")).toBeUndefined();
      });
    });

    test("an aged, unused emerging learning decays end to end", async () => {
      await withDb((db) => {
        db.learnings.addLearning({ id: "silent", title: "Silent", repo: "shared", confidence: "emerging", content: "c", tags: [] });
        backdateCreatedAt(db, "silent", new Date(Date.now() - 200 * DAY).toISOString());

        expect(propose(db)).toMatchObject([{ kind: "decay", learningId: "silent", from: "emerging", idleDays: null }]);
      });
    });
  });
});
