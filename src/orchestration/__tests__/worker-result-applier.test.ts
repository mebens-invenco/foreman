import path from "node:path";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { priorityToRank, type RepoRef, type ResolvedPullRequest, type ReviewContext, type Task, type TaskComment, type WorkerResult } from "../../domain/index.js";
import { LoggerService } from "../../logger.js";
import type { ReviewService } from "../../review/index.js";
import type { TaskSystem } from "../../tasking/index.js";
import { learningEmbeddingText } from "../../embeddings/learning-embedding-text.js";
import { FakeEmbedder, fakeEmbeddingVector } from "../../test-support/fake-embedder.js";
import { createMigratedDb, createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";
import { WorkerResultApplier } from "../worker-result-applier.js";
import { runScoutSelection } from "../scout-selection.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class FakeTaskSystem implements TaskSystem {
  transitions: Array<{ taskId: string; toState: Task["state"] }> = [];
  comments: Array<{ taskId: string; body: string }> = [];
  commentUpdatedAt: string | null = null;
  getTaskError: Error | null = null;
  getTaskFailuresRemaining = 0;

  constructor(private readonly tasks: Task[]) {}

  getProvider(): "file" {
    return "file";
  }

  async listCandidates(): Promise<Task[]> {
    return this.tasks;
  }

  async listAssignedIssues(): Promise<Task[]> {
    return this.tasks;
  }

  async getTask(taskId: string): Promise<Task> {
    if (this.getTaskFailuresRemaining > 0) {
      this.getTaskFailuresRemaining -= 1;
      throw this.getTaskError ?? new Error("transient provider failure");
    }
    if (this.getTaskError) {
      throw this.getTaskError;
    }
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`missing task ${taskId}`);
    }
    return task;
  }

  async createTask(): Promise<{ id: string; providerId: string; url: null }> {
    return { id: "TASK-FOLLOW-UP", providerId: "TASK-FOLLOW-UP", url: null };
  }

  async listComments(): Promise<TaskComment[]> {
    return [];
  }

  async addComment(input: { taskId: string; body: string }): Promise<void> {
    this.comments.push(input);
    const task = this.tasks.find((item) => item.id === input.taskId);
    if (task && this.commentUpdatedAt) {
      task.updatedAt = this.commentUpdatedAt;
    }
  }

  async transition(input: { taskId: string; toState: Task["state"] }): Promise<void> {
    this.transitions.push(input);
  }

  async upsertPullRequest(): Promise<void> {}
  async updateLabels(): Promise<void> {}
}

class FakeReviewService implements ReviewService {
  resolvedThreads: Array<{ pullRequestUrl: string; threadIds: string[] }> = [];

  constructor(
    private readonly pullRequest: ResolvedPullRequest | Record<string, ResolvedPullRequest>,
    private readonly reviewContext: ReviewContext | null = null,
  ) {}

  async resolvePullRequest(_task?: Task, _repo?: RepoRef, target?: { repoKey: string }): Promise<ResolvedPullRequest> {
    const pullRequest = this.pullRequest;
    if (typeof (pullRequest as ResolvedPullRequest).pullRequestUrl === "string") {
      return pullRequest as ResolvedPullRequest;
    }

    return (pullRequest as Record<string, ResolvedPullRequest>)[target?.repoKey ?? "repo-a"]!;
  }

  async getContext(): Promise<ReviewContext | null> {
    return this.reviewContext;
  }

  async findLatestOpenPullRequestBranch(): Promise<string | null> {
    return null;
  }

  async createPullRequest(): Promise<{ url: string; number: number }> {
    throw new Error("not used");
  }

  async submitPullRequestReview(): Promise<void> {
    throw new Error("not used");
  }

  async replyToReviewSummary(): Promise<void> {
    throw new Error("not used");
  }

  async replyToPrComment(): Promise<void> {
    throw new Error("not used");
  }

  async replyToThreadComment(): Promise<void> {
    throw new Error("not used");
  }

  async resolveThreads(pullRequestUrl: string, threadIds: string[]): Promise<void> {
    this.resolvedThreads.push({ pullRequestUrl, threadIds });
  }
}

const task = (): Task => ({
  id: "TASK-DEPLOY-APPLY",
  provider: "file",
  providerId: "TASK-DEPLOY-APPLY",
  title: "Apply deployment result",
  description: "",
  state: "deployable",
  providerState: "deployable",
  priority: "normal",
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: "repo-a", branchName: "task-deploy-apply", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
});

describe("WorkerResultApplier review result mutations", () => {
  test("applies review mutations and saves checkpoints for blocked review results", async () => {
    const tempDir = await createTempDir("foreman-review-applier-blocked-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const reviewTask: Task = {
      ...task(),
      state: "in_review",
      providerState: "in_review",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/67", source: "provider" }],
    };
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/67",
      pullRequestNumber: 67,
      state: "open",
      isDraft: false,
      headBranch: "task-review-apply",
      baseBranch: "main",
    };
    const reviewContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: pullRequest.pullRequestUrl,
      pullRequestNumber: pullRequest.pullRequestNumber,
      state: "open",
      isDraft: false,
      headSha: "abc123",
      headBranch: pullRequest.headBranch,
      baseBranch: pullRequest.baseBranch,
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [{ name: "ci", state: "pending" }],
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([reviewTask]);
      const target = db.taskMirror.getTaskTarget(reviewTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: reviewTask.id,
        taskTargetId: target!.id,
        taskProvider: reviewTask.provider,
        action: "review",
        priorityRank: priorityToRank(reviewTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${reviewTask.id}:repo-a:review`,
        selectionReason: "unresolved review threads",
      });
      const worker = db.workers.listWorkers()[0];
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const taskSystem = new FakeTaskSystem([reviewTask]);
      const reviewService = new FakeReviewService(pullRequest, reviewContext);
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });

      await applier.apply({
        attempt,
        job,
        task: reviewTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action: "review",
          outcome: "blocked",
          summary: "Checks are still pending.",
          taskMutations: [],
          reviewMutations: [{ type: "resolve_threads", threadIds: ["thread-1"] }],
          learningMutations: [],
          blockers: ["Checks are still pending."],
          signals: [],
        },
      });

      expect(reviewService.resolvedThreads).toEqual([{ pullRequestUrl: pullRequest.pullRequestUrl, threadIds: ["thread-1"] }]);
      expect(taskSystem.comments).toEqual([{ taskId: reviewTask.id, body: "[agent] Checks are still pending." }]);
      expect(db.reviewCheckpoints.getReviewCheckpoint(target!.id)).toMatchObject({
        taskId: reviewTask.id,
        taskTargetId: target!.id,
        prUrl: pullRequest.pullRequestUrl,
        headSha: reviewContext.headSha,
        sourceAttemptId: attempt.id,
      });
    } finally {
      db.close();
    }
  });
});

describe("WorkerResultApplier blocked ordinary work", () => {
  test.each(["execution", "retry"] as const)("saves the provider task timestamp observed after %s blocker comments", async (action) => {
    const tempDir = await createTempDir("foreman-execution-applier-blocked-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const executionTask: Task = {
      ...task(),
      id: "TASK-BLOCKED-APPLY",
      providerId: "TASK-BLOCKED-APPLY",
      title: "Apply blocked execution result",
      state: "in_progress",
      providerState: "in_progress",
      updatedAt: "2026-03-14T12:00:00Z",
    };
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/68",
      pullRequestNumber: 68,
      state: "open",
      isDraft: false,
      headBranch: "task-blocked-apply",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([executionTask]);
      const target = db.taskMirror.getTaskTarget(executionTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: executionTask.id,
        taskTargetId: target!.id,
        taskProvider: executionTask.provider,
        action,
        priorityRank: priorityToRank(executionTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${executionTask.id}:repo-a:${action}`,
        selectionReason: "test",
        selectionContext: { existing: true },
      });
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const taskSystem = new FakeTaskSystem([executionTask]);
      taskSystem.commentUpdatedAt = "2026-03-14T12:10:00Z";
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService(pullRequest),
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });

      await applier.apply({
        attempt,
        job,
        task: executionTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action,
          outcome: "blocked",
          summary: "Waiting on dependency.",
          taskMutations: [],
          reviewMutations: [],
          learningMutations: [],
          blockers: ["Dependency has not landed."],
          signals: [],
        },
      });

      expect(taskSystem.comments).toEqual([{ taskId: executionTask.id, body: "[agent] Dependency has not landed." }]);
      expect(db.jobs.getJob(job.id).selectionContext).toMatchObject({
        existing: true,
        blockedTaskUpdatedAt: "2026-03-14T12:10:00Z",
      });
    } finally {
      db.close();
    }
  });

  test("retries blocked task reload and keeps the next scout suppressed after a transient failure", async () => {
    const tempDir = await createTempDir("foreman-execution-applier-blocked-fallback-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const executionTask: Task = {
      ...task(),
      id: "TASK-BLOCKED-FALLBACK",
      providerId: "TASK-BLOCKED-FALLBACK",
      title: "Apply blocked execution fallback",
      state: "in_progress",
      providerState: "in_progress",
      updatedAt: "2026-03-14T12:00:00Z",
    };
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/69",
      pullRequestNumber: 69,
      state: "open",
      isDraft: false,
      headBranch: "task-blocked-fallback",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([executionTask]);
      const target = db.taskMirror.getTaskTarget(executionTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: executionTask.id,
        taskTargetId: target!.id,
        taskProvider: executionTask.provider,
        action: "execution",
        priorityRank: priorityToRank(executionTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${executionTask.id}:repo-a:execution`,
        selectionReason: "test",
      });
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const taskSystem = new FakeTaskSystem([executionTask]);
      taskSystem.commentUpdatedAt = "2026-03-14T12:10:00Z";
      taskSystem.getTaskError = new Error("provider unavailable");
      taskSystem.getTaskFailuresRemaining = 1;
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService(pullRequest),
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });

      await applier.apply({
        attempt,
        job,
        task: executionTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action: "execution",
          outcome: "blocked",
          summary: "Waiting on dependency.",
          taskMutations: [],
          reviewMutations: [],
          learningMutations: [],
          blockers: ["Dependency has not landed."],
          signals: [],
        },
      });

      expect(db.jobs.getJob(job.id).selectionContext).toMatchObject({
        blockedTaskUpdatedAt: "2026-03-14T12:10:00Z",
      });

      db.attempts.finalizeAttempt(attempt.id, "blocked", { finishedAt: "2026-03-14T12:04:00Z" });
      db.jobs.updateJobStatus(job.id, "blocked", { finishedAt: "2026-03-14T12:04:00Z" });
      const scoutResult = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: {
          resolvePullRequest: async () => null,
          getContext: async () => null,
          findLatestOpenPullRequestBranch: async () => null,
        } as any,
        repos: [repo],
        triggerType: "manual",
      });
      expect(scoutResult.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("WorkerResultApplier deployment tracking", () => {
  test("persists successful deployment records and moves the task to done", async () => {
    const tempDir = await createTempDir("foreman-deployment-applier-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const deployableTask = task();
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/60",
      pullRequestNumber: 60,
      state: "merged",
      isDraft: false,
      headBranch: "task-deploy-apply",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([deployableTask]);
      const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        taskProvider: deployableTask.provider,
        action: "deployment",
        priorityRank: priorityToRank(deployableTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${deployableTask.id}:repo-a:deployment`,
        selectionReason: "test",
        selectionContext: {
          deployment: {
            instructionHash: "deploy-hash",
            instructionBody: "Check production once.",
          },
          pullRequestReference: {
            provider: "github",
            url: pullRequest.pullRequestUrl,
            number: pullRequest.pullRequestNumber,
            state: "merged",
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
          },
        },
      });
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const taskSystem = new FakeTaskSystem([deployableTask]);
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService(pullRequest),
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });

      await applier.apply({
        attempt,
        job,
        task: deployableTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action: "deployment",
          outcome: "succeeded",
          summary: "Deployment verified.",
          taskMutations: [],
          reviewMutations: [],
          learningMutations: [],
          blockers: [],
          signals: [],
        },
      });

      expect(db.deploymentTracking.getDeploymentRecord({ taskTargetId: target!.id, prUrl: pullRequest.pullRequestUrl, instructionHash: "deploy-hash" })).toMatchObject({
        latestStatus: "succeeded",
        latestSummary: "Deployment verified.",
        successful: true,
      });
      expect(taskSystem.transitions).toEqual([{ taskId: deployableTask.id, toState: "done" }]);
    } finally {
      db.close();
    }
  });

  test("sets retry eligibility for in-progress deployment results", async () => {
    const tempDir = await createTempDir("foreman-deployment-applier-progress-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.deployment.minRetryIntervalMinutes = 15;
    config.deployment.maxRetryIntervalMinutes = 60;
    const deployableTask = task();
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/61",
      pullRequestNumber: 61,
      state: "merged",
      isDraft: false,
      headBranch: "task-deploy-apply",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([deployableTask]);
      const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        taskProvider: deployableTask.provider,
        action: "deployment",
        priorityRank: priorityToRank(deployableTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${deployableTask.id}:repo-a:deployment`,
        selectionReason: "test",
        selectionContext: {
          deployment: { instructionHash: "deploy-hash", instructionBody: "Check production once." },
          pullRequestReference: {
            provider: "github",
            url: pullRequest.pullRequestUrl,
            number: pullRequest.pullRequestNumber,
            state: "merged",
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
          },
        },
      });
      const worker = db.workers.listWorkers()[0];
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const taskSystem = new FakeTaskSystem([deployableTask]);
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService(pullRequest),
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });
      const before = Date.now();

      await applier.apply({
        attempt,
        job,
        task: deployableTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action: "deployment",
          outcome: "in_progress",
          summary: "Still rolling out.",
          taskMutations: [],
          reviewMutations: [],
          learningMutations: [],
          blockers: [],
          signals: [],
        },
      });

      const record = db.deploymentTracking.getDeploymentRecord({ taskTargetId: target!.id, prUrl: pullRequest.pullRequestUrl, instructionHash: "deploy-hash" });
      expect(record).toMatchObject({ latestStatus: "in_progress", successful: false });
      expect(record!.retryCount).toBe(1);
      expect(Date.parse(record!.nextEligibleAt!)).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);
      expect(taskSystem.transitions).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("sets retry eligibility for failed deployment results", async () => {
    const tempDir = await createTempDir("foreman-deployment-applier-failed-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.deployment.minRetryIntervalMinutes = 15;
    config.deployment.maxRetryIntervalMinutes = 60;
    await fs.writeFile(path.join(tempDir, "deployment.md"), "Check production once.", "utf8");
    const paths = createWorkspacePaths(projectRoot, tempDir);
    const instructionHash = "a693920f695b5bbbcf0933b6a015f6c66b48a443293437b762912ff637ab5e64";
    const deployableTask = task();
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/70",
      pullRequestNumber: 70,
      state: "merged",
      isDraft: false,
      headBranch: "task-deploy-apply",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([deployableTask]);
      const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        taskProvider: deployableTask.provider,
        action: "deployment",
        priorityRank: priorityToRank(deployableTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${deployableTask.id}:repo-a:deployment`,
        selectionReason: "test",
        selectionContext: {
          deployment: { instructionHash, instructionBody: "Check production once." },
          pullRequestReference: {
            provider: "github",
            url: pullRequest.pullRequestUrl,
            number: pullRequest.pullRequestNumber,
            state: "merged",
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
          },
        },
      });
      const worker = db.workers.listWorkers()[0];
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const taskSystem = new FakeTaskSystem([deployableTask]);
      const reviewService = new FakeReviewService(pullRequest);
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });
      const before = Date.now();

      await applier.apply({
        attempt,
        job,
        task: deployableTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action: "deployment",
          outcome: "failed",
          summary: "CI failure already captured in a follow-up.",
          taskMutations: [],
          reviewMutations: [],
          learningMutations: [],
          blockers: [],
          signals: [],
        },
      });

      const record = db.deploymentTracking.getDeploymentRecord({ taskTargetId: target!.id, prUrl: pullRequest.pullRequestUrl, instructionHash });
      expect(record).toMatchObject({ latestStatus: "failed", latestSummary: "CI failure already captured in a follow-up.", retryCount: 1, successful: false });
      expect(Date.parse(record!.nextEligibleAt!)).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);

      db.attempts.finalizeAttempt(attempt.id, "failed", { finishedAt: new Date().toISOString() });
      db.jobs.updateJobStatus(job.id, "failed", { finishedAt: new Date().toISOString(), errorMessage: "CI failure already captured in a follow-up." });
      const scoutResult = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [repo],
        triggerType: "manual",
      });
      expect(scoutResult.jobs.some((selectedJob) => selectedJob.action === "deployment")).toBe(false);

      db.deploymentTracking.upsertDeploymentRecord({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        repoKey: "repo-a",
        prUrl: pullRequest.pullRequestUrl,
        prNumber: pullRequest.pullRequestNumber,
        prHeadBranch: pullRequest.headBranch,
        prBaseBranch: pullRequest.baseBranch,
        instructionHash,
        instructionBody: "Check production once.",
        latestStatus: "failed",
        latestSummary: "CI failure already captured in a follow-up.",
        nextEligibleAt: "2000-01-01T00:00:00.000Z",
        retryCount: record!.retryCount,
        blockedRetryCount: record!.blockedRetryCount,
        createdFollowUpTaskIds: [],
        successful: false,
        sourceAttemptId: attempt.id,
      });

      const eligibleScoutResult = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [repo],
        triggerType: "manual",
      });
      expect(eligibleScoutResult.jobs.map((selectedJob) => selectedJob.action)).toEqual(["deployment"]);
    } finally {
      db.close();
    }
  });

  test("requires follow-up task creation for follow_up_created deployment results", async () => {
    const tempDir = await createTempDir("foreman-deployment-applier-follow-up-missing-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const deployableTask = task();
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/64",
      pullRequestNumber: 64,
      state: "merged",
      isDraft: false,
      headBranch: "task-deploy-apply",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([deployableTask]);
      const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        taskProvider: deployableTask.provider,
        action: "deployment",
        priorityRank: priorityToRank(deployableTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${deployableTask.id}:repo-a:deployment`,
        selectionReason: "test",
        selectionContext: {
          deployment: { instructionHash: "deploy-hash", instructionBody: "Check production once." },
          pullRequestReference: {
            provider: "github",
            url: pullRequest.pullRequestUrl,
            number: pullRequest.pullRequestNumber,
            state: "merged",
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
          },
        },
      });
      const worker = db.workers.listWorkers()[0];
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([deployableTask]),
        reviewService: new FakeReviewService(pullRequest),
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });

      await expect(
        applier.apply({
          attempt,
          job,
          task: deployableTask,
          target: target!,
          repo,
          worktreePath: tempDir,
          workerResult: {
            schemaVersion: 1,
            action: "deployment",
            outcome: "follow_up_created",
            summary: "Follow-up needed.",
            taskMutations: [],
            reviewMutations: [],
            learningMutations: [],
            blockers: [],
            signals: [],
          },
        }),
      ).rejects.toMatchObject({ code: "missing_deployment_follow_up" });
    } finally {
      db.close();
    }
  });

  test("stores created follow-up task ids for follow_up_created deployment results", async () => {
    const tempDir = await createTempDir("foreman-deployment-applier-follow-up-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const deployableTask = task();
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/65",
      pullRequestNumber: 65,
      state: "merged",
      isDraft: false,
      headBranch: "task-deploy-apply",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([deployableTask]);
      const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
      expect(target).not.toBeNull();
      const job = db.jobs.createJob({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        taskProvider: deployableTask.provider,
        action: "deployment",
        priorityRank: priorityToRank(deployableTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${deployableTask.id}:repo-a:deployment`,
        selectionReason: "test",
        selectionContext: {
          deployment: { instructionHash: "deploy-hash", instructionBody: "Check production once." },
          pullRequestReference: {
            provider: "github",
            url: pullRequest.pullRequestUrl,
            number: pullRequest.pullRequestNumber,
            state: "merged",
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
          },
        },
      });
      const worker = db.workers.listWorkers()[0];
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([deployableTask]),
        reviewService: new FakeReviewService(pullRequest),
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });

      await applier.apply({
        attempt,
        job,
        task: deployableTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action: "deployment",
          outcome: "follow_up_created",
          summary: "Follow-up created.",
          taskMutations: [
            {
              type: "create_task",
              title: "Investigate deployment regression",
              description: "Concrete deployment regression evidence was found.",
              repos: ["repo-a"],
            },
          ],
          reviewMutations: [],
          learningMutations: [],
          blockers: [],
          signals: [],
        },
      });

      expect(db.deploymentTracking.getDeploymentRecord({ taskTargetId: target!.id, prUrl: pullRequest.pullRequestUrl, instructionHash: "deploy-hash" })).toMatchObject({
        latestStatus: "follow_up_created",
        createdFollowUpTaskIds: ["TASK-FOLLOW-UP"],
        successful: false,
      });
    } finally {
      db.close();
    }
  });

  test("increments blocked retries, sets retry eligibility, and comments on blocked deployment results", async () => {
    const tempDir = await createTempDir("foreman-deployment-applier-blocked-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.deployment.minRetryIntervalMinutes = 12;
    config.deployment.maxRetryIntervalMinutes = 36;
    const deployableTask = task();
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/66",
      pullRequestNumber: 66,
      state: "merged",
      isDraft: false,
      headBranch: "task-deploy-apply",
      baseBranch: "main",
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([deployableTask]);
      const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
      expect(target).not.toBeNull();
      db.deploymentTracking.upsertDeploymentRecord({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        repoKey: "repo-a",
        prUrl: pullRequest.pullRequestUrl,
        prNumber: pullRequest.pullRequestNumber,
        prHeadBranch: pullRequest.headBranch,
        prBaseBranch: pullRequest.baseBranch,
        instructionHash: "deploy-hash",
        instructionBody: "Check production once.",
        latestStatus: "blocked",
        latestSummary: "Provider unavailable.",
        nextEligibleAt: "2000-01-01T00:00:00.000Z",
        retryCount: 1,
        blockedRetryCount: 1,
        createdFollowUpTaskIds: [],
        successful: false,
        sourceAttemptId: null,
      });
      const job = db.jobs.createJob({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        taskProvider: deployableTask.provider,
        action: "deployment",
        priorityRank: priorityToRank(deployableTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${deployableTask.id}:repo-a:deployment`,
        selectionReason: "test",
        selectionContext: {
          deployment: { instructionHash: "deploy-hash", instructionBody: "Check production once." },
          pullRequestReference: {
            provider: "github",
            url: pullRequest.pullRequestUrl,
            number: pullRequest.pullRequestNumber,
            state: "merged",
            headBranch: pullRequest.headBranch,
            baseBranch: pullRequest.baseBranch,
          },
        },
      });
      const worker = db.workers.listWorkers()[0];
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      const taskSystem = new FakeTaskSystem([deployableTask]);
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService(pullRequest),
        repos: [repo],
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });
      const before = Date.now();

      await applier.apply({
        attempt,
        job,
        task: deployableTask,
        target: target!,
        repo,
        worktreePath: tempDir,
        workerResult: {
          schemaVersion: 1,
          action: "deployment",
          outcome: "blocked",
          summary: "Deployment provider unavailable.",
          taskMutations: [],
          reviewMutations: [],
          learningMutations: [],
          blockers: ["Deployment provider unavailable."],
          signals: [],
        },
      });

      const record = db.deploymentTracking.getDeploymentRecord({ taskTargetId: target!.id, prUrl: pullRequest.pullRequestUrl, instructionHash: "deploy-hash" });
      expect(record).toMatchObject({ latestStatus: "blocked", retryCount: 2, blockedRetryCount: 2, successful: false });
      expect(Date.parse(record!.nextEligibleAt!)).toBeGreaterThanOrEqual(before + 24 * 60 * 1000 - 1000);
      expect(taskSystem.comments).toEqual([{ taskId: deployableTask.id, body: "[agent] Deployment provider unavailable." }]);
    } finally {
      db.close();
    }
  });

  test("waits for all merged targets to succeed before moving the task to done", async () => {
    const tempDir = await createTempDir("foreman-deployment-applier-multi-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const deployableTask = {
      ...task(),
      targets: [
        { repoKey: "repo-a", branchName: "task-deploy-apply", position: 0 },
        { repoKey: "repo-b", branchName: "task-deploy-apply", position: 1 },
      ],
    } satisfies Task;
    const repos: RepoRef[] = [
      { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      { key: "repo-b", rootPath: "/repos/repo-b", defaultBranch: "main" },
    ];
    const pullRequests: Record<string, ResolvedPullRequest> = {
      "repo-a": {
        pullRequestUrl: "https://github.com/acme/repo-a/pull/62",
        pullRequestNumber: 62,
        state: "merged",
        isDraft: false,
        headBranch: "task-deploy-apply",
        baseBranch: "main",
      },
      "repo-b": {
        pullRequestUrl: "https://github.com/acme/repo-b/pull/63",
        pullRequestNumber: 63,
        state: "merged",
        isDraft: false,
        headBranch: "task-deploy-apply",
        baseBranch: "main",
      },
    };

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([deployableTask]);
      const worker = db.workers.listWorkers()[0];
      const taskSystem = new FakeTaskSystem([deployableTask]);
      const applier = new WorkerResultApplier({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService(pullRequests),
        repos,
        embedder: new FakeEmbedder(),
        logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
        scheduleScout: () => undefined,
      });

      for (const repo of repos) {
        const target = db.taskMirror.getTaskTarget(deployableTask.id, repo.key);
        expect(target).not.toBeNull();
        const pullRequest = pullRequests[repo.key]!;
        const job = db.jobs.createJob({
          taskId: deployableTask.id,
          taskTargetId: target!.id,
          taskProvider: deployableTask.provider,
          action: "deployment",
          priorityRank: priorityToRank(deployableTask.priority),
          repoKey: repo.key,
          baseBranch: "main",
          dedupeKey: `${deployableTask.id}:${repo.key}:deployment`,
          selectionReason: "test",
          selectionContext: {
            deployment: { instructionHash: "deploy-hash", instructionBody: "Check production once." },
            pullRequestReference: {
              provider: "github",
              url: pullRequest.pullRequestUrl,
              number: pullRequest.pullRequestNumber,
              state: "merged",
              headBranch: pullRequest.headBranch,
              baseBranch: pullRequest.baseBranch,
            },
          },
        });
        const attempt = db.attempts.createAttempt({
          jobId: job.id,
          workerId: worker!.id,
          runnerName: "opencode",
          runnerModel: "openai/gpt-5.4",
          runnerVariant: "high",
        });

        await applier.apply({
          attempt,
          job,
          task: deployableTask,
          target: target!,
          repo,
          worktreePath: tempDir,
          workerResult: {
            schemaVersion: 1,
            action: "deployment",
            outcome: "succeeded",
            summary: `Deployment verified for ${repo.key}.`,
            taskMutations: [],
            reviewMutations: [],
            learningMutations: [],
            blockers: [],
            signals: [],
          },
        });
      }

      expect(taskSystem.transitions).toEqual([{ taskId: deployableTask.id, toState: "done" }]);
    } finally {
      db.close();
    }
  });
});

describe("WorkerResultApplier learning embeddings", () => {
  const applyLearningMutations = async (
    db: Awaited<ReturnType<typeof createMigratedDb>>,
    embedder: FakeEmbedder,
    learningMutations: WorkerResult["learningMutations"],
    tempDir: string,
  ): Promise<void> => {
    const executionTask: Task = { ...task(), state: "ready", providerState: "ready" };
    const repo: RepoRef = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };
    const pullRequest: ResolvedPullRequest = {
      pullRequestUrl: "https://github.com/acme/repo-a/pull/12",
      pullRequestNumber: 12,
      state: "open",
      isDraft: false,
      headBranch: "task-deploy-apply",
      baseBranch: "main",
    };

    db.workers.ensureWorkerSlots(1);
    db.taskMirror.saveTasks([executionTask]);
    const target = db.taskMirror.getTaskTarget(executionTask.id, "repo-a");
    const job = db.jobs.createJob({
      taskId: executionTask.id,
      taskTargetId: target!.id,
      taskProvider: executionTask.provider,
      action: "execution",
      priorityRank: priorityToRank(executionTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${executionTask.id}:repo-a:execution`,
      selectionReason: "test",
    });
    const worker = db.workers.listWorkers()[0];
    const attempt = db.attempts.createAttempt({
      jobId: job.id,
      workerId: worker!.id,
      runnerName: "opencode",
      runnerModel: "openai/gpt-5.4",
      runnerVariant: "high",
    });
    const applier = new WorkerResultApplier({
      config: createDefaultWorkspaceConfig("foo", "file"),
      foremanRepos: db,
      taskSystem: new FakeTaskSystem([executionTask]),
      reviewService: new FakeReviewService(pullRequest),
      repos: [repo],
      embedder,
      logger: LoggerService.create({ stdout: new PassThrough(), minLevel: "error" }),
      scheduleScout: () => undefined,
    });

    await applier.apply({
      attempt,
      job,
      task: executionTask,
      target: target!,
      repo,
      worktreePath: tempDir,
      workerResult: {
        schemaVersion: 1,
        action: "execution",
        outcome: "no_action_needed",
        summary: "Applied learnings.",
        taskMutations: [],
        reviewMutations: [],
        learningMutations,
        blockers: [],
        signals: [],
      },
    });
  };

  const setUp = async (prefix: string) => {
    const tempDir = await createTempDir(prefix);
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    return { tempDir, db };
  };

  test("embeds the title and content of an added learning", async () => {
    const { tempDir, db } = await setUp("foreman-learning-embed-add-");
    const embedder = new FakeEmbedder();

    try {
      await applyLearningMutations(
        db,
        embedder,
        [{ type: "add", title: "Pin the runner", repo: "foreman", confidence: "emerging", content: "Use ubuntu-24.04.", tags: ["ci"] }],
        tempDir,
      );

      expect(embedder.embeddedTexts).toEqual(["Pin the runner\nUse ubuntu-24.04."]);
      const [embedding] = db.learnings.getLearningEmbeddings();
      expect(embedding).toMatchObject({ model: embedder.modelId, dims: embedder.dims });
      const [learning] = db.learnings.listLearnings();
      expect(embedding!.learningId).toBe(learning!.id);
    } finally {
      db.close();
    }
  });

  test("attaches each vector to the learning whose text produced it", async () => {
    const { tempDir, db } = await setUp("foreman-learning-embed-multi-");
    const embedder = new FakeEmbedder();
    const alpha = { title: "Pin the GHA runner", content: "Use ubuntu-24.04, not ubuntu-latest." };
    const beta = { title: "Commit the lockfile", content: "Reviewers cannot verify resolution without it." };

    try {
      await applyLearningMutations(
        db,
        embedder,
        [
          { type: "add", ...alpha, repo: "foreman", confidence: "emerging", tags: [] },
          { type: "add", ...beta, repo: "foreman", confidence: "emerging", tags: [] },
        ],
        tempDir,
      );

      // One batched embed call, in mutation order.
      expect(embedder.calls).toHaveLength(1);
      expect(embedder.embeddedTexts).toEqual([learningEmbeddingText(alpha), learningEmbeddingText(beta)]);

      const idByTitle = new Map(db.learnings.listLearnings().map((learning) => [learning.title, learning.id]));
      const vectorByLearningId = new Map(
        db.learnings.getLearningEmbeddings().map((row) => [row.learningId, Array.from(row.vector)]),
      );
      expect(vectorByLearningId.size).toBe(2);

      // A reversed or constant-index zip would survive any assertion that only
      // counts rows; tie each stored vector back to its own source text.
      expect(vectorByLearningId.get(idByTitle.get(alpha.title)!)).toEqual(
        Array.from(fakeEmbeddingVector(learningEmbeddingText(alpha), 0)),
      );
      expect(vectorByLearningId.get(idByTitle.get(beta.title)!)).toEqual(
        Array.from(fakeEmbeddingVector(learningEmbeddingText(beta), 1)),
      );
    } finally {
      db.close();
    }
  });

  test("re-embeds an update that changes the content", async () => {
    const { tempDir, db } = await setUp("foreman-learning-embed-update-");
    const embedder = new FakeEmbedder();

    try {
      db.learnings.addLearning({ id: "learn-a", title: "Title", repo: "foreman", confidence: "emerging", content: "Old body", tags: [] });
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-a",
        model: embedder.modelId,
        dims: embedder.dims,
        vector: Float32Array.from([0, 0, 0]),
        embeddedTitle: "Title",
        embeddedContent: "Old body",
      });

      await applyLearningMutations(db, embedder, [{ type: "update", id: "learn-a", content: "New body" }], tempDir);

      expect(embedder.embeddedTexts).toEqual(["Title\nNew body"]);
      expect(Array.from(db.learnings.getLearningEmbeddings()[0]!.vector)).not.toEqual([0, 0, 0]);
    } finally {
      db.close();
    }
  });

  test("skips embedding an update that leaves title and content unchanged", async () => {
    const { tempDir, db } = await setUp("foreman-learning-embed-noop-");
    const embedder = new FakeEmbedder();

    try {
      db.learnings.addLearning({ id: "learn-a", title: "Title", repo: "foreman", confidence: "emerging", content: "Body", tags: [] });

      await applyLearningMutations(
        db,
        embedder,
        [{ type: "update", id: "learn-a", markApplied: true, tags: ["ci"], content: "Body" }],
        tempDir,
      );

      expect(embedder.calls).toHaveLength(0);
      expect(db.learnings.getLearningsByIds(["learn-a"])[0]!.appliedCount).toBe(1);
    } finally {
      db.close();
    }
  });

  test("discards its vector when another writer edits the learning mid-embed", async () => {
    const { tempDir, db } = await setUp("foreman-learning-embed-race-");
    const embedder = new FakeEmbedder();

    try {
      db.learnings.addLearning({ id: "learn-a", title: "Title", repo: "foreman", confidence: "emerging", content: "Old body", tags: [] });

      // A concurrent writer lands a newer edit while our vector is in flight.
      embedder.onEmbed = () => {
        embedder.onEmbed = null;
        db.learnings.updateLearning({ id: "learn-a", content: "Newer body from another writer" });
      };

      await applyLearningMutations(db, embedder, [{ type: "update", id: "learn-a", content: "New body" }], tempDir);

      // Our vector described "New body", which is no longer the stored text.
      expect(db.learnings.getLearningEmbeddings()).toEqual([]);
      // Dropping it leaves the row visible to the backfill, which is the point.
      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toEqual(["learn-a"]);
      expect(db.learnings.getLearningsByIds(["learn-a"])[0]!.content).toBe("Newer body from another writer");
    } finally {
      db.close();
    }
  });

  test("writes the learning and leaves it for backfill when the embedder throws", async () => {
    const { tempDir, db } = await setUp("foreman-learning-embed-fail-");
    const embedder = new FakeEmbedder();
    embedder.failure = new Error("model unavailable");

    try {
      await applyLearningMutations(
        db,
        embedder,
        [{ type: "add", title: "Pin the runner", repo: "foreman", confidence: "emerging", content: "Use ubuntu-24.04.", tags: [] }],
        tempDir,
      );

      const learnings = db.learnings.listLearnings();
      expect(learnings).toHaveLength(1);
      expect(db.learnings.getLearningEmbeddings()).toEqual([]);
      // The row is exactly what `foreman learnings backfill-embeddings` picks up.
      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toEqual([learnings[0]!.id]);
    } finally {
      db.close();
    }
  });

  /** Unit vector whose cosine against [1, 0, 0] is exactly `cosine`. */
  const unitVectorAt = (cosine: number): Float32Array =>
    Float32Array.from([cosine, Math.sqrt(1 - cosine * cosine), 0]);

  const neighbourVector = unitVectorAt(1);

  const seedNeighbour = (
    db: Awaited<ReturnType<typeof createMigratedDb>>,
    embedder: FakeEmbedder,
    overrides: { id?: string; repo?: string; model?: string } = {},
  ): string => {
    const id = overrides.id ?? "learn-neighbour";
    db.learnings.addLearning({
      id,
      title: "Neighbour",
      repo: overrides.repo ?? "foreman",
      confidence: "emerging",
      content: "Neighbour body",
      tags: [],
    });
    db.learnings.upsertLearningEmbedding({
      learningId: id,
      model: overrides.model ?? embedder.modelId,
      dims: embedder.dims,
      vector: neighbourVector,
    });
    return id;
  };

  /** An `add` mutation whose text the fake embedder maps to `vector`. */
  const addMutationAt = (
    embedder: FakeEmbedder,
    vector: Float32Array,
    overrides: { title?: string; repo?: string } = {},
  ): Extract<WorkerResult["learningMutations"][number], { type: "add" }> => {
    const mutation = {
      type: "add" as const,
      title: overrides.title ?? "Candidate",
      repo: overrides.repo ?? "foreman",
      confidence: "emerging" as const,
      content: "Candidate body",
      tags: [],
    };
    embedder.vectorsByText.set(learningEmbeddingText(mutation), vector);
    return mutation;
  };

  const addedLearning = (db: Awaited<ReturnType<typeof createMigratedDb>>) =>
    db.learnings.listLearnings().find((learning) => learning.title === "Candidate")!;

  test("stores and flags an added learning that near-duplicates its nearest in-scope neighbour", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-flag-");
    const embedder = new FakeEmbedder();

    try {
      const neighbourId = seedNeighbour(db, embedder);
      await applyLearningMutations(db, embedder, [addMutationAt(embedder, unitVectorAt(0.92))], tempDir);

      // D3: store + flag. The learning must never be dropped.
      expect(db.learnings.listLearnings()).toHaveLength(2);
      expect(addedLearning(db).duplicateOf).toBe(neighbourId);
    } finally {
      db.close();
    }
  });

  test("never flags an added learning against itself", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-self-");
    const embedder = new FakeEmbedder();

    try {
      // Nothing else is stored, so the only vector that could match is the
      // learning's own -- which the lookup must run before persisting.
      await applyLearningMutations(db, embedder, [addMutationAt(embedder, neighbourVector)], tempDir);

      expect(addedLearning(db).duplicateOf).toBeNull();
      expect(db.learnings.getLearningEmbeddings()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("stores an added learning below the threshold without a duplicate flag", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-clean-");
    const embedder = new FakeEmbedder();

    try {
      seedNeighbour(db, embedder);
      // 0.90 sits just under the 0.91 threshold, so this pins the boundary
      // rather than merely showing an orthogonal vector goes unflagged.
      await applyLearningMutations(db, embedder, [addMutationAt(embedder, unitVectorAt(0.9))], tempDir);

      expect(addedLearning(db).duplicateOf).toBeNull();
    } finally {
      db.close();
    }
  });

  test("stores the learning unflagged when the embedder fails, and never fails the apply", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-embed-fail-");
    const embedder = new FakeEmbedder();

    try {
      seedNeighbour(db, embedder);
      const mutation = addMutationAt(embedder, neighbourVector);
      embedder.failure = new Error("model unavailable");

      await applyLearningMutations(db, embedder, [mutation], tempDir);

      const learning = addedLearning(db);
      expect(learning.duplicateOf).toBeNull();
      expect(learning.sourceTaskId).toBe("TASK-DEPLOY-APPLY");
      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toContain(learning.id);
    } finally {
      db.close();
    }
  });

  test("records the source task on every added learning", async () => {
    const { tempDir, db } = await setUp("foreman-learning-source-task-");
    const embedder = new FakeEmbedder();

    try {
      await applyLearningMutations(
        db,
        embedder,
        [
          { type: "add", title: "First", repo: "foreman", confidence: "emerging", content: "One", tags: [] },
          { type: "add", title: "Second", repo: "shared", confidence: "proven", content: "Two", tags: [] },
        ],
        tempDir,
      );

      expect(db.learnings.listLearnings().map((learning) => learning.sourceTaskId)).toEqual([
        "TASK-DEPLOY-APPLY",
        "TASK-DEPLOY-APPLY",
      ]);
    } finally {
      db.close();
    }
  });

  test("flags the second of two near-identical adds in one worker result", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-same-batch-");
    const embedder = new FakeEmbedder();

    try {
      const first = addMutationAt(embedder, neighbourVector, { title: "First" });
      const second = addMutationAt(embedder, neighbourVector, { title: "Candidate" });

      await applyLearningMutations(db, embedder, [first, second], tempDir);

      const firstLearning = db.learnings.listLearnings().find((learning) => learning.title === "First")!;
      // The first add has no neighbour to point at; its vector is stored before
      // the second add's lookup runs, so only the second is flagged.
      expect(firstLearning.duplicateOf).toBeNull();
      expect(addedLearning(db).duplicateOf).toBe(firstLearning.id);
    } finally {
      db.close();
    }
  });

  test("flags against a shared-repo neighbour", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-shared-");
    const embedder = new FakeEmbedder();

    try {
      const neighbourId = seedNeighbour(db, embedder, { repo: "shared" });
      await applyLearningMutations(db, embedder, [addMutationAt(embedder, neighbourVector)], tempDir);

      expect(addedLearning(db).duplicateOf).toBe(neighbourId);
    } finally {
      db.close();
    }
  });

  test("ignores an identical neighbour in an unrelated repo", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-other-repo-");
    const embedder = new FakeEmbedder();

    try {
      seedNeighbour(db, embedder, { repo: "warehousing-service" });
      await applyLearningMutations(db, embedder, [addMutationAt(embedder, neighbourVector)], tempDir);

      expect(addedLearning(db).duplicateOf).toBeNull();
    } finally {
      db.close();
    }
  });

  test("ignores an identical neighbour embedded by a different model", async () => {
    const { tempDir, db } = await setUp("foreman-learning-dup-other-model-");
    const embedder = new FakeEmbedder();

    try {
      // Mid-backfill the table holds two model generations. Their vectors share
      // no space, so a 1.0 cosine across them is a coincidence, not a duplicate.
      seedNeighbour(db, embedder, { model: "superseded-embedder-v0" });
      await applyLearningMutations(db, embedder, [addMutationAt(embedder, neighbourVector)], tempDir);

      expect(addedLearning(db).duplicateOf).toBeNull();
    } finally {
      db.close();
    }
  });

  test("zips vectors onto adds by add position, not mutation position", async () => {
    const { tempDir, db } = await setUp("foreman-learning-interleaved-");
    const embedder = new FakeEmbedder();

    try {
      db.learnings.addLearning({ id: "learn-x", title: "X", repo: "foreman", confidence: "emerging", content: "x", tags: [] });
      db.learnings.addLearning({ id: "learn-y", title: "Y", repo: "foreman", confidence: "emerging", content: "y", tags: [] });

      const alphaVector = Float32Array.from([2, 0, 0]);
      const betaVector = Float32Array.from([0, 3, 0]);
      const alpha = addMutationAt(embedder, alphaVector, { title: "Alpha" });
      const beta = addMutationAt(embedder, betaVector, { title: "Beta" });

      // Interleaving is the only shape where an add's index diverges from its
      // position in `mutations`. An all-add batch makes the two identical, so a
      // loop-position bug would zip correctly there and land `undefined` here.
      await applyLearningMutations(
        db,
        embedder,
        [{ type: "update", id: "learn-x", content: "x2" }, alpha, { type: "update", id: "learn-y", content: "y2" }, beta],
        tempDir,
      );

      const idByTitle = new Map(db.learnings.listLearnings().map((learning) => [learning.title, learning.id]));
      const vectorByLearningId = new Map(
        db.learnings.getLearningEmbeddings().map((row) => [row.learningId, Array.from(row.vector)]),
      );

      expect(vectorByLearningId.get(idByTitle.get("Alpha")!)).toEqual([2, 0, 0]);
      expect(vectorByLearningId.get(idByTitle.get("Beta")!)).toEqual([0, 3, 0]);
      // Adds are embedded up front; the two content-changing updates re-embed in
      // a second batched call.
      expect(embedder.calls).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("keeps the learning and completes the apply when the embedding write throws", async () => {
    const { tempDir, db } = await setUp("foreman-learning-embed-write-fail-");
    const embedder = new FakeEmbedder();

    try {
      const neighbourId = seedNeighbour(db, embedder);
      const failing = new Error("SQLITE_BUSY: database is locked");
      db.learnings.upsertLearningEmbedding = () => {
        throw failing;
      };

      // The learning row commits before its vector is written, so a failing
      // embedding write must not abort the apply and strand later mutations.
      await expect(
        applyLearningMutations(db, embedder, [addMutationAt(embedder, neighbourVector)], tempDir),
      ).resolves.toBeUndefined();

      const learning = addedLearning(db);
      expect(learning.duplicateOf).toBe(neighbourId);
      expect(learning.sourceTaskId).toBe("TASK-DEPLOY-APPLY");
      expect(db.learnings.listLearningIdsMissingEmbedding(embedder.modelId)).toContain(learning.id);
    } finally {
      db.close();
    }
  });
});
