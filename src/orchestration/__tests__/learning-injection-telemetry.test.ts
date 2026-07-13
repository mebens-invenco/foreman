import path from "node:path";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { priorityToRank, type RepoRef, type ResolvedPullRequest, type Task, type TaskComment, type WorkerResult } from "../../domain/index.js";
import { renderWorkerPrompt } from "../../execution/render-worker-prompt.js";
import { LoggerService } from "../../logger.js";
import type { ReviewService } from "../../review/index.js";
import type { TaskSystem } from "../../tasking/index.js";
import { FakeEmbedder } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { WorkerResultApplier } from "../worker-result-applier.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

const repo: RepoRef = { key: "foreman", rootPath: "/repos/foreman", defaultBranch: "master" };

const task: Task = {
  id: "ENG-1",
  provider: "file",
  providerId: "ENG-1",
  title: "vector retrieval tuning",
  description: "Rank the learnings.",
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "foreman", branchName: "eng-1", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-07-13T00:00:00Z",
  url: null,
};

const taskQuery = `${task.title}\n${task.description}`;

/** The learning the fake embedder makes a cosine outlier for `taskQuery`. */
const injectedId = "learn-target";
/** Real, but never retrieved — an agent can still apply it off its own back. */
const unInjectedId = "learn-elsewhere";

const seedCorpus = (db: Db): void => {
  db.learnings.addLearning({
    id: injectedId,
    title: "Rank the fused arms",
    repo: "shared",
    confidence: "established",
    content: "**Rule:** Rank the fused arms.\n**When to apply:** Retrieval.",
    tags: [],
  });
  db.learnings.upsertLearningEmbedding({
    learningId: injectedId,
    model: "fake-embedder-v1",
    dims: 3,
    vector: Float32Array.from([0, 1, 0]),
    embeddedTitle: "Rank the fused arms",
    embeddedContent: "**Rule:** Rank the fused arms.\n**When to apply:** Retrieval.",
  });

  db.learnings.addLearning({
    id: unInjectedId,
    title: "Something the agent already knew",
    repo: "shared",
    confidence: "established",
    content: "**Rule:** Unrelated to the query.\n**When to apply:** Never here.",
    tags: [],
  });
  db.learnings.upsertLearningEmbedding({
    learningId: unInjectedId,
    model: "fake-embedder-v1",
    dims: 3,
    vector: Float32Array.from([1, 0, 0]),
    embeddedTitle: "Something the agent already knew",
    embeddedContent: "**Rule:** Unrelated to the query.\n**When to apply:** Never here.",
  });

  // The corpus has to be mostly noise for the target to stand out as an outlier.
  for (let index = 0; index < 12; index += 1) {
    const content = `filler ${index} unrelated`;
    db.learnings.addLearning({
      id: `pad-${index}`,
      title: `pad-${index}`,
      repo: "shared",
      confidence: "emerging",
      content,
      tags: [],
    });
    db.learnings.upsertLearningEmbedding({
      learningId: `pad-${index}`,
      model: "fake-embedder-v1",
      dims: 3,
      vector: Float32Array.from([1, 0, 0]),
      embeddedTitle: `pad-${index}`,
      embeddedContent: content,
    });
  }
};

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
    return { id: "TASK-FOLLOW-UP", providerId: "TASK-FOLLOW-UP", url: null };
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

const workerResult = (learningId: string): WorkerResult => ({
  schemaVersion: 1,
  action: "execution",
  outcome: "completed",
  summary: "Done.",
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [{ type: "update", id: learningId, markApplied: true }],
  blockers: [],
  signals: [],
});

/**
 * A whole attempt, end to end: the prompt is rendered against the seeded corpus
 * (which is what writes the injection rows), then the attempt's own worker result
 * is applied (which is what stamps them). Both halves must see the same attempt
 * id or the join this telemetry exists for does not close.
 */
const runAttempt = async (
  db: Db,
  workspaceRoot: string,
  input: { appliedLearningId: string | null },
): Promise<{ attemptId: string; prompt: string }> => {
  db.workers.ensureWorkerSlots(1);
  db.taskMirror.saveTasks([task]);
  const target = db.taskMirror.getTaskTarget(task.id, "foreman")!;
  const job = db.jobs.createJob({
    taskId: task.id,
    taskTargetId: target.id,
    taskProvider: task.provider,
    action: "execution",
    priorityRank: priorityToRank(task.priority),
    repoKey: "foreman",
    baseBranch: "master",
    dedupeKey: `${task.id}:foreman:execution:${input.appliedLearningId ?? "none"}`,
    selectionReason: "ready task",
  });
  const attempt = db.attempts.createAttempt({
    jobId: job.id,
    workerId: db.workers.listWorkers()[0]!.id,
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    runnerVariant: "high",
  });

  const embedder = new FakeEmbedder();
  embedder.vectorsByText.set(taskQuery, Float32Array.from([0, 1, 0]));
  const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);

  const prompt = await renderWorkerPrompt({
    action: "execution",
    config: createDefaultWorkspaceConfig("automation-pilot", "file"),
    paths,
    task,
    repo,
    taskTarget: target,
    worktreePath: workspaceRoot,
    baseBranch: "master",
    learningInjection: {
      learnings: db.learnings,
      embedder,
      warn: () => {},
      telemetry: { events: db.learningInjectionEvents, attemptId: attempt.id },
    },
  });

  if (input.appliedLearningId) {
    const applier = new WorkerResultApplier({
      config: createDefaultWorkspaceConfig("automation-pilot", "file"),
      foremanRepos: db,
      taskSystem: new FakeTaskSystem(),
      reviewService: new FakeReviewService(),
      repos: [repo],
      embedder,
      logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
      scheduleScout: () => undefined,
    });

    await applier.apply({
      attempt,
      job,
      task,
      target,
      repo,
      worktreePath: workspaceRoot,
      workerResult: workerResult(input.appliedLearningId),
    });
  }

  return { attemptId: attempt.id, prompt };
};

const withWorkspace = async (run: (db: Db, workspaceRoot: string) => Promise<void>): Promise<void> => {
  const workspaceRoot = await createTempDir("foreman-injection-telemetry-");
  cleanupDirs.push(workspaceRoot);
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
  try {
    seedCorpus(db);
    await run(db, workspaceRoot);
  } finally {
    db.close();
  }
};

describe("injection telemetry", () => {
  describe("when the attempt applies a learning that was injected into it", () => {
    test("the stats join it into the hit rate", async () => {
      await withWorkspace(async (db, workspaceRoot) => {
        const { prompt } = await runAttempt(db, workspaceRoot, { appliedLearningId: injectedId });

        expect(prompt).toContain(injectedId);
        expect(db.learningInjectionEvents.getInjectionStats()).toMatchObject({
          eligibleAttempts: 1,
          attemptsWithInjection: 1,
          attemptsWithInjectionRate: 1,
          injectedLearnings: 1,
          appliedLearnings: 1,
          hitRate: 1,
          topAppliedLearnings: [
            { learningId: injectedId, title: "Rank the fused arms", injectedCount: 1, appliedCount: 1 },
          ],
        });
      });
    });
  });

  describe("when the attempt applies a learning that was never injected into it", () => {
    test("applied_count still counts it, but the hit rate does not", async () => {
      await withWorkspace(async (db, workspaceRoot) => {
        await runAttempt(db, workspaceRoot, { appliedLearningId: unInjectedId });

        // The honour-system counter moved; the measured one did not. That gap is
        // the whole point of the join.
        expect(db.learnings.getLearningsByIds([unInjectedId])[0]!.appliedCount).toBe(1);
        expect(db.learningInjectionEvents.getInjectionStats()).toMatchObject({
          injectedLearnings: 1,
          appliedLearnings: 0,
          hitRate: 0,
          topAppliedLearnings: [],
        });
      });
    });
  });

  describe("when an attempt is injected into but applies nothing", () => {
    test("it counts against the hit rate, not out of it", async () => {
      await withWorkspace(async (db, workspaceRoot) => {
        await runAttempt(db, workspaceRoot, { appliedLearningId: null });

        expect(db.learningInjectionEvents.getInjectionStats()).toMatchObject({
          eligibleAttempts: 1,
          attemptsWithInjection: 1,
          injectedLearnings: 1,
          appliedLearnings: 0,
          hitRate: 0,
        });
      });
    });
  });

  describe("when a learning is deleted", () => {
    test("its injection history goes with it", async () => {
      await withWorkspace(async (db, workspaceRoot) => {
        await runAttempt(db, workspaceRoot, { appliedLearningId: injectedId });
        expect(db.learningInjectionEvents.getInjectionStats().injectedLearnings).toBe(1);

        db.database.sqlite.prepare("DELETE FROM learning WHERE id = ?").run(injectedId);

        expect(db.learningInjectionEvents.getInjectionStats()).toMatchObject({
          injectedLearnings: 0,
          appliedLearnings: 0,
          hitRate: 0,
          topAppliedLearnings: [],
        });
      });
    });
  });

  describe("--since", () => {
    test("counts only attempts started inside the window", async () => {
      await withWorkspace(async (db, workspaceRoot) => {
        const { attemptId } = await runAttempt(db, workspaceRoot, { appliedLearningId: injectedId });
        db.database.sqlite.prepare("UPDATE execution_attempt SET started_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", attemptId);

        expect(db.learningInjectionEvents.getInjectionStats({ since: "2026-01-01T00:00:00.000Z" })).toMatchObject({
          eligibleAttempts: 0,
          attemptsWithInjection: 0,
          injectedLearnings: 0,
          hitRate: 0,
        });
        expect(db.learningInjectionEvents.getInjectionStats({ since: "2019-01-01T00:00:00.000Z" })).toMatchObject({
          eligibleAttempts: 1,
          injectedLearnings: 1,
          appliedLearnings: 1,
          hitRate: 1,
        });
      });
    });
  });
});
