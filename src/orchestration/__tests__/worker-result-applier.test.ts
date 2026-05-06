import path from "node:path";
import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { priorityToRank, type RepoRef, type ResolvedPullRequest, type ReviewContext, type Task, type TaskComment } from "../../domain/index.js";
import { LoggerService } from "../../logger.js";
import type { ReviewService } from "../../review/index.js";
import type { TaskSystem } from "../../tasking/index.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { WorkerResultApplier } from "../worker-result-applier.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class FakeTaskSystem implements TaskSystem {
  transitions: Array<{ taskId: string; toState: Task["state"] }> = [];
  comments: Array<{ taskId: string; body: string }> = [];

  constructor(private readonly tasks: Task[]) {}

  getProvider(): "file" {
    return "file";
  }

  async listCandidates(): Promise<Task[]> {
    return this.tasks;
  }

  async getTask(taskId: string): Promise<Task> {
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
  }

  async transition(input: { taskId: string; toState: Task["state"] }): Promise<void> {
    this.transitions.push(input);
  }

  async upsertPullRequest(): Promise<void> {}
  async updateLabels(): Promise<void> {}
}

class FakeReviewService implements ReviewService {
  constructor(private readonly pullRequest: ResolvedPullRequest | Record<string, ResolvedPullRequest>) {}

  async resolvePullRequest(_task?: Task, _repo?: RepoRef, target?: { repoKey: string }): Promise<ResolvedPullRequest> {
    if ("pullRequestUrl" in this.pullRequest) {
      return this.pullRequest;
    }

    return this.pullRequest[target?.repoKey ?? "repo-a"]!;
  }

  async getContext(): Promise<ReviewContext | null> {
    return null;
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

  async resolveThreads(): Promise<void> {
    throw new Error("not used");
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
  pullRequests: [],
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
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
    config.deployment.retryIntervalMinutes = 15;
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
      expect(Date.parse(record!.nextEligibleAt!)).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);
      expect(taskSystem.transitions).toEqual([]);
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
