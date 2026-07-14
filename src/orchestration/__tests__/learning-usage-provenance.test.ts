import path from "node:path";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import type { ActionType, RepoRef, ResolvedPullRequest, Task, TaskComment, WorkerResult } from "../../domain/index.js";
import { LoggerService } from "../../logger.js";
import type { ForemanRepos } from "../../repos/index.js";
import type { ReviewService } from "../../review/index.js";
import type { TaskSystem } from "../../tasking/index.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, seedExecutionAttempt, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { WorkerResultApplier } from "../worker-result-applier.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Db = Awaited<ReturnType<typeof createMigratedDb>>;
type AppliedEventRow = { attempt_id: string; task_id: string; action: string; learning_id: string };

const repo: RepoRef = { key: "foreman", rootPath: "/repos/foreman", defaultBranch: "master" };

const task: Task = {
  id: "ENG-A",
  provider: "file",
  providerId: "ENG-A",
  title: "a task",
  description: "",
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "foreman", branchName: "eng-a", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-07-14T00:00:00Z",
  url: null,
};

/** Never injected into anything — the agent found it on its own. */
const SELF_FOUND = "learn-self-found";

class FakeTaskSystem implements TaskSystem {
  getProvider(): "file" {
    return "file";
  }
  async listCandidates(): Promise<Task[]> {
    return [task];
  }
  async listAssignedIssues(): Promise<Task[]> {
    return [task];
  }
  async getTask(): Promise<Task> {
    return task;
  }
  async createTask(): Promise<{ id: string; providerId: string; url: null }> {
    return { id: "ENG-FOLLOW-UP", providerId: "ENG-FOLLOW-UP", url: null };
  }
  async listComments(): Promise<TaskComment[]> {
    return [];
  }
  async addComment(): Promise<void> {}
  async transition(): Promise<void> {}
  async upsertPullRequest(): Promise<void> {}
  async updateLabels(): Promise<void> {}
}

class FakeReviewService implements ReviewService {
  async resolvePullRequest(): Promise<ResolvedPullRequest | null> {
    return null;
  }
  async findLatestOpenPullRequestBranch(): Promise<string | null> {
    return null;
  }
  async getContext(): Promise<null> {
    return null;
  }
  async createPullRequest(): Promise<{ url: string; number: number }> {
    throw new Error("unused");
  }
  async replyToReviewSummary(): Promise<void> {}
  async replyToThreadComment(): Promise<void> {}
  async replyToPrComment(): Promise<void> {}
  async submitPullRequestReview(): Promise<void> {}
  async resolveThreads(): Promise<void> {}
}

const markAppliedResult = (action: ActionType, learningId: string): WorkerResult =>
  ({
    schemaVersion: 1,
    action,
    outcome: "completed",
    summary: "Done.",
    taskMutations: [],
    reviewMutations: [],
    learningMutations: [{ type: "update", id: learningId, markApplied: true }],
    blockers: [],
    signals: [],
  }) as WorkerResult;

const applyMarkApplied = async (
  db: Db,
  input: { action: ActionType; foremanRepos?: ForemanRepos; warnings?: string[] },
): Promise<void> => {
  const attempt = seedExecutionAttempt(db, { task, repoKey: "foreman", action: input.action });
  const job = db.jobs.getJob(attempt.jobId)!;
  const target = db.taskMirror.getTaskTarget(task.id, "foreman")!;

  const stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => input.warnings?.push(chunk.toString()));

  const applier = new WorkerResultApplier({
    config: createDefaultWorkspaceConfig("automation-pilot", "file"),
    foremanRepos: input.foremanRepos ?? db,
    taskSystem: new FakeTaskSystem(),
    reviewService: new FakeReviewService(),
    repos: [repo],
    embedder: new FakeEmbedder(),
    logger: LoggerService.create({ stdout, minLevel: "warn" }),
    scheduleScout: () => undefined,
  });

  await applier.apply({
    attempt,
    job,
    task,
    target,
    repo,
    worktreePath: "/tmp/worktree",
    workerResult: markAppliedResult(input.action, SELF_FOUND),
  });
};

const appliedEvents = (db: Db): AppliedEventRow[] =>
  db.database.sqlite
    .prepare("SELECT attempt_id, task_id, action, learning_id FROM learning_applied_event")
    .all() as AppliedEventRow[];

const withDb = async (run: (db: Db) => Promise<void>): Promise<void> => {
  const workspaceRoot = await createTempDir("foreman-usage-provenance-");
  cleanupDirs.push(workspaceRoot);
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
  try {
    db.learnings.addLearning({
      id: SELF_FOUND,
      title: "Found by the agent",
      repo: "shared",
      confidence: "emerging",
      content: "**Rule:** Something.\n**When to apply:** Somewhere.",
      tags: [],
    });
    await run(db);
  } finally {
    db.close();
  }
};

describe("learning applied-event provenance", () => {
  describe("when an attempt marks a learning applied", () => {
    // The injection stamp deliberately ignores a learning that was never pushed.
    // This event must not: promotion asks whether other tasks found the learning
    // useful, and an agent digging it up unprompted is exactly that evidence.
    test("the apply is recorded against its task even though nothing was injected", async () => {
      await withDb(async (db) => {
        await applyMarkApplied(db, { action: "execution" });

        expect(appliedEvents(db)).toEqual([
          expect.objectContaining({ task_id: task.id, action: "execution", learning_id: SELF_FOUND }),
        ]);
        expect(db.learningUsage.getUsageStats().learnings).toEqual([
          expect.objectContaining({ learningId: SELF_FOUND, distinctTasksApplied: 1, appliedCount: 1 }),
        ]);
      });
    });

    test("the event carries the attempt it was applied in", async () => {
      await withDb(async (db) => {
        await applyMarkApplied(db, { action: "execution" });

        const [event] = appliedEvents(db);
        expect(db.attempts.getAttempt(event!.attempt_id)).toBeTruthy();
      });
    });

    // Not hardcoded to `execution`: a review stage applying a learning is the
    // cross-stage touch this ticket exists to make countable.
    test("a review stage stamps its own action", async () => {
      await withDb(async (db) => {
        await applyMarkApplied(db, { action: "review" });

        expect(appliedEvents(db)).toEqual([expect.objectContaining({ action: "review" })]);
      });
    });
  });

  // `updateLearning` has already committed when the telemetry insert runs. A
  // failed insert costs one usage row; failing the apply would cost the learning.
  describe("when recording the applied event fails", () => {
    test("the apply still stands, and the failure is warned rather than thrown", async () => {
      await withDb(async (db) => {
        const warnings: string[] = [];
        const brokenTelemetry: ForemanRepos = {
          ...db,
          learningUsage: {
            ...db.learningUsage,
            recordApplied: () => {
              throw new Error("disk is on fire");
            },
          },
        };

        await expect(applyMarkApplied(db, { action: "execution", foremanRepos: brokenTelemetry, warnings })).resolves.toBeUndefined();

        expect(appliedEvents(db)).toEqual([]);
        expect(db.learnings.getLearningsByIds([SELF_FOUND])[0]).toMatchObject({ appliedCount: 1 });
        expect(warnings.join("")).toContain("failed to record learning applied event");
      });
    });
  });
});
