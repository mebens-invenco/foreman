import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  priorityToRank,
  type ActionType,
  type AttemptStatus,
  type RepoRef,
  type ResolvedPullRequest,
  type ReviewContext,
  type Task,
  type TaskComment,
  type TaskPullRequest,
} from "../../domain/index.js";
import { runScoutSelection } from "../index.js";
import type { ReviewService } from "../../review/index.js";
import { FileTaskSystem } from "../../tasking/index.js";
import type { TaskSystem } from "../../tasking/index.js";
import { ForemanError } from "../../lib/errors.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import * as worktrees from "../../workspace/git-worktrees.js";
import { createMigratedDb, createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class FakeTaskSystem implements TaskSystem {
  comments = new Map<string, TaskComment[]>();
  transitions: Array<{ taskId: string; toState: Task["state"] }> = [];

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
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`missing task ${taskId}`);
    }
    return task;
  }

  async createTask(): Promise<{ id: string; providerId: string; url: null }> {
    return { id: "TASK-NEW", providerId: "TASK-NEW", url: null };
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    return this.comments.get(taskId) ?? [];
  }

  async addComment(input: { taskId: string; body: string }): Promise<void> {
    const existing = this.comments.get(input.taskId) ?? [];
    existing.push({
      id: `${input.taskId}-${existing.length + 1}`,
      taskId: input.taskId,
      body: input.body,
      authorName: "agent",
      authorKind: "agent",
      createdAt: new Date().toISOString(),
      updatedAt: null,
    });
    this.comments.set(input.taskId, existing);
  }

  async transition(input: { taskId: string; toState: Task["state"] }): Promise<void> {
    this.transitions.push(input);
    const task = this.tasks.find((item) => item.id === input.taskId);
    if (task) {
      task.state = input.toState;
      task.providerState = input.toState;
    }
  }
  async upsertPullRequest(): Promise<void> {}
  async updateLabels(): Promise<void> {}
}

class FakeReviewService implements ReviewService {
  constructor(private readonly contexts: Record<string, ReviewContext | null>) {}

  private contextFor(task: Task, target?: { repoKey: string }): ReviewContext | null {
    return this.contexts[`${task.id}:${target?.repoKey ?? ""}`] ?? this.contexts[task.id] ?? null;
  }

  async resolvePullRequest(task: Task, _repo?: RepoRef, _target?: { repoKey: string; branchName: string }): Promise<ResolvedPullRequest | null> {
    const context = this.contextFor(task, _target);
    if (!context) {
      return null;
    }
    return {
      pullRequestUrl: context.pullRequestUrl,
      pullRequestNumber: context.pullRequestNumber,
      state: context.state,
      isDraft: context.isDraft,
      headBranch: context.headBranch,
      baseBranch: context.baseBranch,
    };
  }

  async getContext(task: Task, _agentPrefix: string, _repo?: RepoRef, _target?: { repoKey: string; branchName: string }): Promise<ReviewContext | null> {
    return this.contextFor(task, _target);
  }

  async findLatestOpenPullRequestBranch(task: Task, _repo?: RepoRef, _target?: { repoKey: string; branchName: string }): Promise<string | null> {
    const context = this.contextFor(task, _target);
    return context?.state === "open" ? context.headBranch : null;
  }

  async createPullRequest(_input: { cwd: string; title: string; body: string; draft: boolean; baseBranch: string; headBranch: string }): Promise<{ url: string; number: number }> {
    throw new Error("not used");
  }

  async submitPullRequestReview(_prUrl: string, _input: { body: string; event: "COMMENT"; comments: Array<{ path: string; line: number; side?: "LEFT" | "RIGHT"; body: string }> }): Promise<void> {
    throw new Error("not used");
  }

  async replyToReviewSummary(_prUrl: string, _reviewId: string, _body: string): Promise<void> {
    throw new Error("not used");
  }

  async replyToPrComment(_prUrl: string, _commentId: string, _body: string): Promise<void> {
    throw new Error("not used");
  }

  async replyToThreadComment(_prUrl: string, _threadId: string, _body: string): Promise<void> {
    throw new Error("not used");
  }

  async resolveThreads(_prUrl: string, _threadIds: string[]): Promise<void> {
    throw new Error("not used");
  }
}

const task = (input: Partial<Task> & Pick<Task, "id" | "title" | "state" | "providerState" | "priority" | "updatedAt">): Task => ({
  provider: "file",
  providerId: input.id,
  description: "",
  labels: ["Agent"],
  assignee: null,
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  url: null,
  ...input,
  targets:
    input.targets ??
    [{ repoKey: "repo-a", branchName: input.id.toLowerCase(), position: 0 }],
  targetDependencies: input.targetDependencies ?? [],
});

const reviewContext = (input: Partial<ReviewContext> & Pick<ReviewContext, "pullRequestUrl" | "pullRequestNumber" | "state" | "headBranch" | "baseBranch">): ReviewContext => ({
  provider: "github",
  isDraft: false,
  headSha: "abc",
  headIntroducedAt: "2026-03-14T12:00:00Z",
  mergeState: "clean",
  reviewSummaries: [],
  conversationComments: [],
  reviewThreads: [],
  failingChecks: [],
  pendingChecks: [],
  ...input,
});

const seedCompletedExecution = (
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  completedTask: Task,
): void => {
  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0];
  expect(worker).toBeDefined();
  db.taskMirror.saveTasks([completedTask]);
  const target = db.taskMirror.getTaskTarget(completedTask.id, completedTask.targets[0]?.repoKey ?? "repo-a");
  expect(target).not.toBeNull();

  const job = db.jobs.createJob({
    taskId: completedTask.id,
    taskTargetId: target!.id,
    taskProvider: completedTask.provider,
    action: "execution",
    priorityRank: priorityToRank(completedTask.priority),
    repoKey: target!.repoKey,
    baseBranch: "main",
    dedupeKey: `${completedTask.id}:${target!.repoKey}:execution`,
    selectionReason: "test",
  });
  db.jobs.updateJobStatus(job.id, "completed", { finishedAt: "2026-03-14T12:04:00Z" });
  const attempt = db.attempts.createAttemptWithLeases({
    jobId: job.id,
    workerId: worker!.id,
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    runnerVariant: "high",
    expiresAt: "2026-03-14T12:05:00Z",
    leases: [],
  });
  expect(attempt).not.toBeNull();
  db.attempts.finalizeAttempt(attempt!.id, "completed", { finishedAt: "2026-03-14T12:04:00Z" });
};

const seedBlockedOrdinaryJob = (
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  blockedTask: Task,
  action: Extract<ActionType, "execution" | "retry">,
  options: { attemptStatus?: AttemptStatus; blockedTaskUpdatedAt?: string } = {},
): void => {
  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0];
  expect(worker).toBeDefined();
  db.taskMirror.saveTasks([blockedTask]);
  const target = db.taskMirror.getTaskTarget(blockedTask.id, blockedTask.targets[0]?.repoKey ?? "repo-a");
  expect(target).not.toBeNull();

  const job = db.jobs.createJob({
    taskId: blockedTask.id,
    taskTargetId: target!.id,
    taskProvider: blockedTask.provider,
    action,
    priorityRank: priorityToRank(blockedTask.priority),
    repoKey: target!.repoKey,
    baseBranch: "main",
    dedupeKey: `${blockedTask.id}:${target!.repoKey}:${action}`,
    selectionReason: "test blocked ordinary work",
    selectionContext: { blockedTaskUpdatedAt: options.blockedTaskUpdatedAt ?? blockedTask.updatedAt },
  });
  const attempt = db.attempts.createAttemptWithLeases({
    jobId: job.id,
    workerId: worker!.id,
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    runnerVariant: "high",
    expiresAt: "2026-03-14T12:05:00Z",
    leases: [],
  });
  expect(attempt).not.toBeNull();
  db.attempts.finalizeAttempt(attempt!.id, options.attemptStatus ?? "blocked", { finishedAt: "2026-03-14T12:04:00Z" });
  db.jobs.updateJobStatus(job.id, "blocked", { finishedAt: "2026-03-14T12:04:00Z" });
};

const seedReviewerCheckpoint = (
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  reviewTask: Task,
  reviewContext: ReviewContext,
): void => {
  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0];
  expect(worker).toBeDefined();
  db.taskMirror.saveTasks([reviewTask]);
  const target = db.taskMirror.getTaskTarget(reviewTask.id, reviewTask.targets[0]?.repoKey ?? "repo-a");
  expect(target).not.toBeNull();

  const reviewerJob = db.jobs.createJob({
    taskId: reviewTask.id,
    taskTargetId: target!.id,
    taskProvider: reviewTask.provider,
    action: "reviewer",
    priorityRank: priorityToRank(reviewTask.priority),
    repoKey: target!.repoKey,
    baseBranch: reviewContext.baseBranch,
    dedupeKey: `${reviewTask.id}:${target!.repoKey}:reviewer`,
    selectionReason: "test",
  });
  db.jobs.updateJobStatus(reviewerJob.id, "completed", { finishedAt: "2026-03-14T12:04:00Z" });
  const attempt = db.attempts.createAttemptWithLeases({
    jobId: reviewerJob.id,
    workerId: worker!.id,
    runnerName: "claude",
    runnerModel: "claude-opus-4-6",
    runnerVariant: "high",
    expiresAt: "2026-03-14T12:05:00Z",
    leases: [],
  });
  expect(attempt).not.toBeNull();

  db.reviewerCheckpoints.upsertReviewerCheckpoint({
    taskId: reviewTask.id,
    taskTargetId: target!.id,
    prUrl: reviewContext.pullRequestUrl,
    reviewContext,
    sourceAttemptId: attempt!.id,
  });
};

const seedReviewCheckpoint = (
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  reviewTask: Task,
  reviewContext: ReviewContext,
): void => {
  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0];
  expect(worker).toBeDefined();
  db.taskMirror.saveTasks([reviewTask]);
  const target = db.taskMirror.getTaskTarget(reviewTask.id, reviewTask.targets[0]?.repoKey ?? "repo-a");
  expect(target).not.toBeNull();

  const reviewJob = db.jobs.createJob({
    taskId: reviewTask.id,
    taskTargetId: target!.id,
    taskProvider: reviewTask.provider,
    action: "review",
    priorityRank: priorityToRank(reviewTask.priority),
    repoKey: target!.repoKey,
    baseBranch: reviewContext.baseBranch,
    dedupeKey: `${reviewTask.id}:${target!.repoKey}:review`,
    selectionReason: "test",
  });
  db.jobs.updateJobStatus(reviewJob.id, "blocked", { finishedAt: "2026-03-14T12:04:00Z" });
  const attempt = db.attempts.createAttemptWithLeases({
    jobId: reviewJob.id,
    workerId: worker!.id,
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    runnerVariant: "high",
    expiresAt: "2026-03-14T12:05:00Z",
    leases: [],
  });
  expect(attempt).not.toBeNull();

  db.reviewCheckpoints.upsertReviewCheckpoint({
    taskId: reviewTask.id,
    taskTargetId: target!.id,
    prUrl: reviewContext.pullRequestUrl,
    reviewContext,
    sourceAttemptId: attempt!.id,
  });
};

const seedCanceledRetryAttempt = (
  db: Awaited<ReturnType<typeof createMigratedDb>>,
  retryTask: Task,
  options: { manuallyStopped: boolean; attemptStatus?: AttemptStatus; jobStatus?: "canceled" | "completed" | "failed" },
): { attemptId: string; jobId: string; targetId: string } => {
  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0];
  expect(worker).toBeDefined();
  db.taskMirror.saveTasks([retryTask]);
  const target = db.taskMirror.getTaskTarget(retryTask.id, retryTask.targets[0]?.repoKey ?? "repo-a");
  expect(target).not.toBeNull();

  const retryJob = db.jobs.createJob({
    taskId: retryTask.id,
    taskTargetId: target!.id,
    taskProvider: retryTask.provider,
    action: "retry",
    priorityRank: priorityToRank(retryTask.priority),
    repoKey: target!.repoKey,
    baseBranch: "main",
    dedupeKey: `${retryTask.id}:${target!.repoKey}:retry`,
    selectionReason: "test retry",
  });
  const attempt = db.attempts.createAttemptWithLeases({
    jobId: retryJob.id,
    workerId: worker!.id,
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    runnerVariant: "high",
    expiresAt: "2026-03-14T12:05:00Z",
    leases: [],
  });
  expect(attempt).not.toBeNull();
  if (options.manuallyStopped) {
    db.attempts.addAttemptEvent(attempt!.id, "attempt_stop_requested", `Stop requested for attempt ${attempt!.id}`);
  }
  db.attempts.finalizeAttempt(attempt!.id, options.attemptStatus ?? "canceled", {
    finishedAt: "2026-03-14T12:04:00Z",
    signal: "SIGTERM",
    summary: "Runner exited with signal SIGTERM",
    errorMessage: "Runner exited with signal SIGTERM",
  });
  db.jobs.updateJobStatus(retryJob.id, options.jobStatus ?? "canceled", {
    finishedAt: "2026-03-14T12:04:00Z",
    errorMessage: "Runner exited with signal SIGTERM",
  });
  return { attemptId: attempt!.id, jobId: retryJob.id, targetId: target!.id };
};

const writeFileTask = async (workspaceRoot: string, input: { id: string; title: string; state: string; repo?: string }): Promise<void> => {
  await fs.mkdir(path.join(workspaceRoot, "tasks"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "tasks", `${input.id}.md`),
    `---
id: ${input.id}
title: ${input.title}
state: ${input.state}
priority: normal
labels:
  - Agent
repo: ${input.repo ?? "repo-a"}
createdAt: 2026-03-14T12:00:00Z
updatedAt: 2026-03-14T12:00:00Z
---

Task body
`,
    "utf8",
  );
};

describe("runScoutSelection", () => {
  test("does not immediately reselect a manually stopped retry on worker-finished scout", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const retryTask = task({
      id: "TASK-STOPPED-RETRY",
      title: "Stopped retry task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/101", source: "provider" } satisfies TaskPullRequest],
    });
    seedCanceledRetryAttempt(db, retryTask, { manuallyStopped: true });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([retryTask]),
        reviewService: new FakeReviewService({
          [retryTask.id]: reviewContext({
            pullRequestUrl: "https://github.com/acme/repo-a/pull/101",
            pullRequestNumber: 101,
            state: "closed",
            headBranch: "task-stopped-retry",
            baseBranch: "main",
          }),
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "worker_finished",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test.each(["poll", "startup", "lease_change", "task_mutation", "manual"] as const)(
    "allows manually stopped retry targets on later %s scouts",
    async (triggerType) => {
      const tempDir = await createTempDir("foreman-scout-test-");
      cleanupDirs.push(tempDir);
      const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
      const config = createDefaultWorkspaceConfig("foo", "file");

      const retryTask = task({
        id: "TASK-STOPPED-RETRY-LATER",
        title: "Stopped retry task later",
        state: "in_review",
        providerState: "in_review",
        priority: "normal",
        updatedAt: "2026-03-14T12:00:00Z",
        pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/102", source: "provider" } satisfies TaskPullRequest],
      });
      seedCanceledRetryAttempt(db, retryTask, { manuallyStopped: true });

      try {
        const result = await runScoutSelection({
          config,
          foremanRepos: db,
          taskSystem: new FakeTaskSystem([retryTask]),
          reviewService: new FakeReviewService({
            [retryTask.id]: reviewContext({
              pullRequestUrl: "https://github.com/acme/repo-a/pull/102",
              pullRequestNumber: 102,
              state: "closed",
              headBranch: "task-stopped-retry-later",
              baseBranch: "main",
            }),
          }),
          repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
          triggerType,
        });

        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0]?.action).toBe("retry");
        expect(result.jobs[0]?.selectionReason).toBe("closed unmerged pull request eligible for retry");
      } finally {
        db.close();
      }
    },
  );

  test("still selects canceled retry attempts without manual stop events", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const retryTask = task({
      id: "TASK-CANCELED-RETRY",
      title: "Canceled retry task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/103", source: "provider" } satisfies TaskPullRequest],
    });
    seedCanceledRetryAttempt(db, retryTask, { manuallyStopped: false });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([retryTask]),
        reviewService: new FakeReviewService({
          [retryTask.id]: reviewContext({
            pullRequestUrl: "https://github.com/acme/repo-a/pull/103",
            pullRequestNumber: 103,
            state: "closed",
            headBranch: "task-canceled-retry",
            baseBranch: "main",
          }),
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "worker_finished",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("retry");
    } finally {
      db.close();
    }
  });

  test.each(["completed", "failed"] as const)(
    "still selects retries when a stop-requested attempt finalized as %s",
    async (status) => {
      const tempDir = await createTempDir("foreman-scout-test-");
      cleanupDirs.push(tempDir);
      const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
      const config = createDefaultWorkspaceConfig("foo", "file");

      const retryTask = task({
        id: `TASK-STOP-RACE-${status.toUpperCase()}`,
        title: `Stop race ${status} retry task`,
        state: "in_review",
        providerState: "in_review",
        priority: "normal",
        updatedAt: "2026-03-14T12:00:00Z",
        pullRequests: [{ repoKey: "repo-a", url: `https://github.com/acme/repo-a/pull/${status === "completed" ? 105 : 106}`, source: "provider" } satisfies TaskPullRequest],
      });
      seedCanceledRetryAttempt(db, retryTask, {
        manuallyStopped: true,
        attemptStatus: status,
        jobStatus: status,
      });

      try {
        const result = await runScoutSelection({
          config,
          foremanRepos: db,
          taskSystem: new FakeTaskSystem([retryTask]),
          reviewService: new FakeReviewService({
            [retryTask.id]: reviewContext({
              pullRequestUrl: `https://github.com/acme/repo-a/pull/${status === "completed" ? 105 : 106}`,
              pullRequestNumber: status === "completed" ? 105 : 106,
              state: "closed",
              headBranch: `task-stop-race-${status}`,
              baseBranch: "main",
            }),
          }),
          repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
          triggerType: "worker_finished",
        });

        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0]?.action).toBe("retry");
      } finally {
        db.close();
      }
    },
  );

  test("does not suppress worker-finished retries when the stop event belongs to an older job", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const retryTask = task({
      id: "TASK-STALE-STOPPED-RETRY",
      title: "Stale stopped retry task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/104", source: "provider" } satisfies TaskPullRequest],
    });
    const seeded = seedCanceledRetryAttempt(db, retryTask, { manuallyStopped: true });
    db.database.sqlite
      .prepare("UPDATE job SET created_at = ?, updated_at = ?, finished_at = ? WHERE id = ?")
      .run("2026-03-14T12:00:00Z", "2026-03-14T12:04:00Z", "2026-03-14T12:04:00Z", seeded.jobId);
    db.database.sqlite
      .prepare("UPDATE execution_attempt SET started_at = ?, finished_at = ? WHERE id = ?")
      .run("2026-03-14T12:01:00Z", "2026-03-14T12:04:00Z", seeded.attemptId);
    const newerRetryJob = db.jobs.createJob({
      taskId: retryTask.id,
      taskTargetId: seeded.targetId,
      taskProvider: retryTask.provider,
      action: "retry",
      priorityRank: priorityToRank(retryTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${retryTask.id}:repo-a:retry`,
      selectionReason: "test newer retry",
    });
    db.jobs.updateJobStatus(newerRetryJob.id, "canceled", {
      finishedAt: "2026-03-14T12:07:00Z",
      errorMessage: "Canceled before attempt creation",
    });
    db.database.sqlite
      .prepare("UPDATE job SET created_at = ?, updated_at = ?, finished_at = ? WHERE id = ?")
      .run("2026-03-14T12:06:00Z", "2026-03-14T12:07:00Z", "2026-03-14T12:07:00Z", newerRetryJob.id);

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([retryTask]),
        reviewService: new FakeReviewService({
          [retryTask.id]: reviewContext({
            pullRequestUrl: "https://github.com/acme/repo-a/pull/104",
            pullRequestNumber: 104,
            state: "closed",
            headBranch: "task-stale-stopped-retry",
            baseBranch: "main",
          }),
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "worker_finished",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("retry");
    } finally {
      db.close();
    }
  });

  test("promotes in-review tasks with merged pull requests to deployable", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-5052A",
      title: "Merged review task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/1", source: "provider" } satisfies TaskPullRequest],
    });
    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/1",
        pullRequestNumber: 1,
        state: "merged",
        headBranch: "task-5052a",
        baseBranch: "main",
      }),
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
      expect(taskSystem.transitions).toEqual([{ taskId: reviewTask.id, toState: "deployable" }]);
      expect(db.taskMirror.getTask(reviewTask.id)).toMatchObject({ state: "deployable", providerState: "deployable" });
    } finally {
      db.close();
    }
  });

  test("promotes merged pull request tasks directly to done for repos done on merge and consolidates in the same scout", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.repos.reposDoneOnMerge = ["repo-a"];
    config.scheduler.consolidateTerminalTasks = true;

    const reviewTask = task({
      id: "TASK-5052B",
      title: "Merged done-on-merge task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/2", source: "provider" } satisfies TaskPullRequest],
    });
    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/2",
        pullRequestNumber: 2,
        state: "merged",
        headBranch: "task-5052b",
        baseBranch: "main",
      }),
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(taskSystem.transitions).toEqual([{ taskId: reviewTask.id, toState: "done" }]);
      expect(db.taskMirror.getTask(reviewTask.id)).toMatchObject({ state: "done", providerState: "done" });
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe(reviewTask.id);
      expect(result.jobs[0]?.action).toBe("consolidation");
    } finally {
      db.close();
    }
  });

  test("schedules consolidation even when a branch-consuming job is active for the same target", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.consolidateTerminalTasks = true;

    const doneTask = task({
      id: "TASK-5052L",
      title: "Done task with active branch job",
      state: "done",
      providerState: "done",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/22", source: "provider" } satisfies TaskPullRequest],
    });
    db.taskMirror.saveTasks([doneTask]);
    const target = db.taskMirror.getTaskTarget(doneTask.id, "repo-a");
    expect(target).not.toBeNull();
    db.jobs.createJob({
      taskId: doneTask.id,
      taskTargetId: target!.id,
      taskProvider: doneTask.provider,
      action: "review",
      priorityRank: priorityToRank(doneTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${doneTask.id}:repo-a:review`,
      selectionReason: "test active review",
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([doneTask]),
        reviewService: new FakeReviewService({
          [doneTask.id]: reviewContext({
            pullRequestUrl: "https://github.com/acme/repo-a/pull/22",
            pullRequestNumber: 22,
            state: "merged",
            headBranch: "task-5052l",
            baseBranch: "main",
          }),
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("consolidation");
    } finally {
      db.close();
    }
  });

  test("does not schedule consolidation for tasks that already have the consolidated label", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.scheduler.consolidateTerminalTasks = true;

    const doneTask = task({
      id: "TASK-5052M",
      title: "Already consolidated task",
      state: "done",
      providerState: "done",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      labels: ["Agent", "Agent Consolidated"],
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([doneTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("does not reschedule consolidation after a completed consolidation job for the target", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.consolidateTerminalTasks = true;

    const doneTask = task({
      id: "TASK-5052N",
      title: "Previously consolidated task",
      state: "done",
      providerState: "done",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      labels: ["Agent"],
    });
    db.taskMirror.saveTasks([doneTask]);
    const target = db.taskMirror.getTaskTarget(doneTask.id, "repo-a");
    expect(target).not.toBeNull();
    const consolidationJob = db.jobs.createJob({
      taskId: doneTask.id,
      taskTargetId: target!.id,
      taskProvider: doneTask.provider,
      action: "consolidation",
      priorityRank: priorityToRank(doneTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${doneTask.id}:repo-a:consolidation`,
      selectionReason: "test completed consolidation",
    });
    db.jobs.updateJobStatus(consolidationJob.id, "completed", { finishedAt: "2026-03-14T12:04:00Z" });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([doneTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("does not reschedule consolidation after a canceled consolidation attempt (no infinite re-pick loop)", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.consolidateTerminalTasks = true;

    const doneTask = task({
      id: "TASK-5052Q",
      title: "Done task whose consolidation was canceled mid-run",
      state: "done",
      providerState: "done",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      labels: ["Agent"],
    });
    db.taskMirror.saveTasks([doneTask]);
    const target = db.taskMirror.getTaskTarget(doneTask.id, "repo-a");
    expect(target).not.toBeNull();
    // A consolidation that was killed by a scheduler pause (SIGTERM) ends
    // "canceled", never swaps the labels, and must not be re-picked forever.
    const consolidationJob = db.jobs.createJob({
      taskId: doneTask.id,
      taskTargetId: target!.id,
      taskProvider: doneTask.provider,
      action: "consolidation",
      priorityRank: priorityToRank(doneTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${doneTask.id}:repo-a:consolidation`,
      selectionReason: "test canceled consolidation",
    });
    db.jobs.updateJobStatus(consolidationJob.id, "canceled", { finishedAt: "2026-03-14T12:04:00Z" });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([doneTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("does not schedule terminal tasks for consolidation when consolidateTerminalTasks is off", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.scheduler.consolidateTerminalTasks = false;

    const doneTask = task({
      id: "TASK-5052P",
      title: "Done task that must stay done",
      state: "done",
      providerState: "done",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      labels: ["Agent"],
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([doneTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("promotes mixed done-on-merge multi-target tasks to deployable", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.repos.reposDoneOnMerge = ["repo-a"];

    const reviewTask = task({
      id: "TASK-5052C",
      title: "Mixed merged task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      targets: [
        { repoKey: "repo-a", branchName: "task-5052c", position: 0 },
        { repoKey: "repo-b", branchName: "task-5052c", position: 1 },
      ],
      pullRequests: [
        { repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/3", source: "provider" } satisfies TaskPullRequest,
        { repoKey: "repo-b", url: "https://github.com/acme/repo-b/pull/4", source: "provider" } satisfies TaskPullRequest,
      ],
    });
    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({
      [`${reviewTask.id}:repo-a`]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/3",
        pullRequestNumber: 3,
        state: "merged",
        headBranch: "task-5052c",
        baseBranch: "main",
      }),
      [`${reviewTask.id}:repo-b`]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-b/pull/4",
        pullRequestNumber: 4,
        state: "merged",
        headBranch: "task-5052c",
        baseBranch: "main",
      }),
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [
          { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
          { key: "repo-b", rootPath: "/repos/repo-b", defaultBranch: "main" },
        ],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
      expect(taskSystem.transitions).toEqual([{ taskId: reviewTask.id, toState: "deployable" }]);
      expect(db.taskMirror.getTask(reviewTask.id)).toMatchObject({ state: "deployable", providerState: "deployable" });
    } finally {
      db.close();
    }
  });

  test("leaves completed targets without pull requests in review", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-5052D",
      title: "Completed without pull request",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    seedCompletedExecution(db, reviewTask);
    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({});

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
      expect(taskSystem.transitions).toEqual([]);
      expect(db.taskMirror.getTask(reviewTask.id)).toMatchObject({ state: "in_review" });
    } finally {
      db.close();
    }
  });

  test("prioritizes review before execution", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0002",
      title: "Review task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/1", source: "provider" } satisfies TaskPullRequest],
    });
    const readyTask = task({
      id: "TASK-0001",
      title: "Ready task",
      state: "ready",
      providerState: "ready",
      priority: "urgent",
      updatedAt: "2026-03-14T11:00:00Z",
    });

    const taskSystem = new FakeTaskSystem([readyTask, reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: {
        provider: "github",
        pullRequestUrl: "https://github.com/acme/repo-a/pull/1",
        pullRequestNumber: 1,
        state: "open",
        isDraft: false,
        headSha: "abc",
        headBranch: "task-0002",
        baseBranch: "main",
        headIntroducedAt: "2026-03-14T12:00:00Z",
        mergeState: "clean",
        reviewSummaries: [{ id: "rev-1", body: "Please fix", authorName: "reviewer", authoredByAgent: false, createdAt: "2026-03-14T12:01:00Z", commitId: "abc", isCurrentHead: true }],
        conversationComments: [],
        reviewThreads: [],
        failingChecks: [],
        pendingChecks: [{ name: "ci", state: "pending" }],
      },
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0002");
      expect(result.jobs[1]?.action).toBe("execution");
      expect(db.taskMirror.getTask("TASK-0002")).toMatchObject({
        id: "TASK-0002",
        targets: [{ repoKey: "repo-a", branchName: "task-0002", position: 0 }],
      });
    } finally {
      db.close();
    }
  });

  test("continues scout selection when one file candidate has an unmapped provider state", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    await writeFileTask(tempDir, {
      id: "TASK-0001",
      title: "Valid task",
      state: "ready",
    });
    await writeFileTask(tempDir, {
      id: "TASK-0002",
      title: "Skipped task",
      state: "blocked",
    });

    const taskSystem = new FileTaskSystem(config, createWorkspacePaths(projectRoot, tempDir));
    const reviewService = new FakeReviewService({});

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.task.id).toBe("TASK-0001");
    } finally {
      db.close();
    }
  });

  test("prioritizes actionable review work for in-progress tasks with open pull requests", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0003",
      title: "In-progress review task",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/2", source: "provider" } satisfies TaskPullRequest],
    });
    const readyTask = task({
      id: "TASK-0004",
      title: "Ready task",
      state: "ready",
      providerState: "ready",
      priority: "urgent",
      updatedAt: "2026-03-14T11:00:00Z",
    });

    const taskSystem = new FakeTaskSystem([readyTask, reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: {
        provider: "github",
        pullRequestUrl: "https://github.com/acme/repo-a/pull/2",
        pullRequestNumber: 2,
        state: "open",
        isDraft: false,
        headSha: "abc",
        headBranch: "task-0003",
        baseBranch: "main",
        headIntroducedAt: "2026-03-14T12:00:00Z",
        mergeState: "clean",
        reviewSummaries: [],
        conversationComments: [
          {
            id: "comment-1",
            body: "Please remove this extra step.",
            authorName: "reviewer",
            authoredByAgent: false,
            createdAt: "2026-03-14T12:05:00Z",
            isAfterCurrentHead: true,
            url: "https://github.com/acme/repo-a/pull/2#issuecomment-1",
          },
        ],
        reviewThreads: [],
        failingChecks: [],
        pendingChecks: [{ name: "ci", state: "pending" }],
      },
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0003");
      expect(result.jobs[1]?.action).toBe("execution");
      expect(result.jobs[1]?.task.id).toBe("TASK-0004");
    } finally {
      db.close();
    }
  });

  test("treats conflicting pull requests as review work", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0003",
      title: "Conflicting review task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/2", source: "provider" } satisfies TaskPullRequest],
    });

    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: {
        provider: "github",
        pullRequestUrl: "https://github.com/acme/repo-a/pull/2",
        pullRequestNumber: 2,
        state: "open",
        isDraft: false,
        headSha: "def",
        headBranch: "task-0003",
        baseBranch: "main",
        headIntroducedAt: "2026-03-14T12:00:00Z",
        mergeState: "conflicting",
        reviewSummaries: [],
        conversationComments: [],
        reviewThreads: [],
        failingChecks: [],
        pendingChecks: [{ name: "ci", state: "pending" }],
      },
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0003");
    } finally {
      db.close();
    }
  });

  test("does not resume blocked in-progress execution targets until the task is updated", async () => {
    const tempDir = await createTempDir("foreman-scout-blocked-execution-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const blockedTask = task({
      id: "TASK-BLOCKED-EXECUTION",
      title: "Blocked execution task",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    seedBlockedOrdinaryJob(db, blockedTask, "execution");
    const taskSystem = new FakeTaskSystem([blockedTask]);

    try {
      const blocked = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(blocked.jobs).toHaveLength(0);

      blockedTask.updatedAt = "2999-01-01T00:00:00.000Z";
      const unblocked = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(unblocked.jobs).toHaveLength(1);
      expect(unblocked.jobs[0]?.action).toBe("execution");
      expect(unblocked.jobs[0]?.task.id).toBe(blockedTask.id);
    } finally {
      db.close();
    }
  });

  test("keeps blocked execution targets suppressed when provider timestamps are ahead of the job clock", async () => {
    const tempDir = await createTempDir("foreman-scout-blocked-execution-clock-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const blockedTask = task({
      id: "TASK-BLOCKED-EXECUTION-CLOCK",
      title: "Blocked execution with provider clock ahead",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2999-01-01T00:00:00.000Z",
    });
    seedBlockedOrdinaryJob(db, blockedTask, "execution");

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([blockedTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("keeps blocked execution targets suppressed when task timestamps are malformed", async () => {
    const tempDir = await createTempDir("foreman-scout-blocked-execution-malformed-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const blockedTask = task({
      id: "TASK-BLOCKED-EXECUTION-MALFORMED",
      title: "Blocked execution with malformed timestamp",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "not-a-date",
    });
    seedBlockedOrdinaryJob(db, blockedTask, "execution");

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([blockedTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("resumes blocked jobs without worker-declared blocked markers", async () => {
    const tempDir = await createTempDir("foreman-scout-blocked-execution-missing-marker-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const blockedTask = task({
      id: "TASK-BLOCKED-EXECUTION-MISSING-MARKER",
      title: "Blocked execution without worker marker",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    seedBlockedOrdinaryJob(db, blockedTask, "execution");
    const target = db.taskMirror.getTaskTarget(blockedTask.id, "repo-a");
    expect(target).not.toBeNull();
    const seededJob = db.jobs.latestJobForTaskTarget(target!.id);
    expect(seededJob).not.toBeNull();
    db.jobs.updateJobSelectionContext(seededJob!.id, {});

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([blockedTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.task.id).toBe(blockedTask.id);
    } finally {
      db.close();
    }
  });

  test("resumes blocked jobs when the latest attempt is no longer blocked", async () => {
    const tempDir = await createTempDir("foreman-scout-blocked-execution-completed-attempt-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const blockedTask = task({
      id: "TASK-BLOCKED-JOB-COMPLETED-ATTEMPT",
      title: "Blocked job with completed latest attempt",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    seedBlockedOrdinaryJob(db, blockedTask, "execution", { attemptStatus: "completed" });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([blockedTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.task.id).toBe(blockedTask.id);
    } finally {
      db.close();
    }
  });

  test("does not retry blocked ordinary retry targets until the task is updated", async () => {
    const tempDir = await createTempDir("foreman-scout-blocked-retry-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const retryTask = task({
      id: "TASK-BLOCKED-RETRY",
      title: "Blocked retry task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/3", source: "provider" } satisfies TaskPullRequest],
    });
    seedBlockedOrdinaryJob(db, retryTask, "retry");
    const reviewService = new FakeReviewService({
      [retryTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/3",
        pullRequestNumber: 3,
        state: "closed",
        headBranch: "task-blocked-retry",
        baseBranch: "main",
      }),
    });
    const taskSystem = new FakeTaskSystem([retryTask]);

    try {
      const blocked = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(blocked.jobs).toHaveLength(0);

      retryTask.updatedAt = "2999-01-01T00:00:00.000Z";
      const unblocked = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(unblocked.jobs).toHaveLength(1);
      expect(unblocked.jobs[0]?.action).toBe("retry");
      expect(unblocked.jobs[0]?.task.id).toBe(retryTask.id);
    } finally {
      db.close();
    }
  });

  test("does not reselect blocked review work when failing checks match the checkpoint", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0010",
      title: "Blocked review task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/10", source: "provider" } satisfies TaskPullRequest],
    });
    const blockedContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/10",
      pullRequestNumber: 10,
      state: "open",
      isDraft: false,
      headSha: "blocked-head",
      headBranch: "task-0010",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [{ name: "ci/circleci: DEV deploy compute", state: "failure" }],
      pendingChecks: [],
    };
    seedReviewCheckpoint(db, reviewTask, blockedContext);

    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: blockedContext,
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("reselects blocked review work when the failing check fingerprint changes", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0011",
      title: "Changed blocked review task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/11", source: "provider" } satisfies TaskPullRequest],
    });
    const blockedContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/11",
      pullRequestNumber: 11,
      state: "open",
      isDraft: false,
      headSha: "blocked-head",
      headBranch: "task-0011",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [{ name: "ci/circleci: DEV deploy compute", state: "failure" }],
      pendingChecks: [],
    };
    const changedContext: ReviewContext = {
      ...blockedContext,
      failingChecks: [{ name: "ci/circleci: Browser tests", state: "failure" }],
    };
    seedReviewCheckpoint(db, reviewTask, blockedContext);

    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: changedContext,
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.selectionReason).toBe("failing checks");
      const reviewTarget = db.taskMirror.getTaskTarget(reviewTask.id, "repo-a");
      expect(reviewTarget).not.toBeNull();
      expect(db.reviewCheckpoints.getReviewCheckpoint(reviewTarget!.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("reselects review work when unresolved review thread activity changes after a checkpoint", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0004",
      title: "Threaded review task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/4", source: "provider" } satisfies TaskPullRequest],
    });

    const priorContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/4",
      pullRequestNumber: 4,
      state: "open",
      isDraft: false,
      headSha: "ghi",
      headBranch: "task-0004",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [
        {
          id: "thread-1",
          path: "src/example.ts",
          line: 20,
          isResolved: false,
          comments: [
            {
              id: "thread-comment-1",
              body: "Please revisit this",
              authorName: "reviewer",
              authoredByAgent: false,
              createdAt: "2026-03-14T12:01:00Z",
            },
          ],
        },
      ],
      failingChecks: [],
      pendingChecks: [],
    };
    const currentContext: ReviewContext = {
      ...priorContext,
      reviewThreads: [
        {
          ...priorContext.reviewThreads[0]!,
          comments: [
            ...priorContext.reviewThreads[0]!.comments,
            {
              id: "thread-comment-2",
              body: "One more thought",
              authorName: "reviewer",
              authoredByAgent: false,
              createdAt: "2026-03-14T12:02:00Z",
            },
          ],
        },
      ],
    };

    const taskSystem = new FakeTaskSystem([reviewTask]);
    const reviewService = new FakeReviewService({
      [reviewTask.id]: currentContext,
    });

    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0];
    expect(worker).toBeDefined();
    db.taskMirror.saveTasks([reviewTask]);
    const reviewTarget = db.taskMirror.getTaskTarget(reviewTask.id, "repo-a");
    expect(reviewTarget).not.toBeNull();

    const reviewJob = db.jobs.createJob({
      taskId: reviewTask.id,
      taskTargetId: reviewTarget!.id,
      taskProvider: reviewTask.provider,
      action: "review",
      priorityRank: priorityToRank(reviewTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${reviewTask.id}:review`,
      selectionReason: "test",
    });
    db.jobs.updateJobStatus(reviewJob.id, "completed", { finishedAt: "2026-03-14T12:04:00Z" });
    const attempt = db.attempts.createAttemptWithLeases({
      jobId: reviewJob.id,
      workerId: worker!.id,
      runnerName: "opencode",
      runnerModel: "openai/gpt-5.4",
      runnerVariant: "high",
      expiresAt: "2026-03-14T12:05:00Z",
      leases: [],
    });

    expect(attempt).not.toBeNull();
    db.reviewCheckpoints.upsertReviewCheckpoint({
      taskId: reviewTask.id,
      taskTargetId: reviewTarget!.id,
      prUrl: priorContext.pullRequestUrl,
      reviewContext: priorContext,
      sourceAttemptId: attempt!.id,
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0004");
      expect(db.reviewCheckpoints.getReviewCheckpoint(reviewTarget!.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("schedules reviewer work when unresolved review threads are waiting on reviewer confirmation", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005",
      title: "Waiting on reviewer",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/5", source: "provider" } satisfies TaskPullRequest],
    });

    const reviewContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/5",
      pullRequestNumber: 5,
      state: "open",
      isDraft: false,
      headSha: "jkl",
      headBranch: "task-0005",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [
        {
          id: "thread-1",
          path: "src/example.ts",
          line: 20,
          isResolved: false,
          comments: [
            {
              id: "thread-comment-1",
              body: "Please revisit this",
              authorName: "reviewer",
              authoredByAgent: false,
              createdAt: "2026-03-14T12:01:00Z",
            },
            {
              id: "thread-comment-2",
              body: "[agent] I think this is already correct because it preserves the prior behavior.",
              authorName: "foreman-bot",
              authoredByAgent: true,
              createdAt: "2026-03-14T12:02:00Z",
            },
          ],
        },
      ],
      failingChecks: [],
      pendingChecks: [],
    };

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({ [reviewTask.id]: reviewContext }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("reviewer");
    } finally {
      db.close();
    }
  });

  test("selects reviewer work for in-review pull requests when no actionable review work exists", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005R",
      title: "Reviewer eligible task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/50", source: "provider" } satisfies TaskPullRequest],
    });

    const reviewContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/50",
      pullRequestNumber: 50,
      state: "open",
      isDraft: true,
      headSha: "rev-50",
      headBranch: "task-0005r",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [],
    };

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({ [reviewTask.id]: reviewContext }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("reviewer");
      expect(result.jobs[0]?.task.id).toBe("TASK-0005R");
    } finally {
      db.close();
    }
  });

  test("selects reviewer work while checks are pending", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005P",
      title: "Reviewer waiting on checks",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/51", source: "provider" } satisfies TaskPullRequest],
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({
          [reviewTask.id]: {
            provider: "github",
            pullRequestUrl: "https://github.com/acme/repo-a/pull/51",
            pullRequestNumber: 51,
            state: "open",
            isDraft: true,
            headSha: "rev-51",
            headBranch: "task-0005p",
            baseBranch: "main",
            headIntroducedAt: "2026-03-14T12:00:00Z",
            mergeState: "clean",
            reviewSummaries: [],
            conversationComments: [],
            reviewThreads: [],
            failingChecks: [],
            pendingChecks: [{ name: "ci", state: "pending" }],
          },
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("reviewer");
      expect(result.jobs[0]?.task.id).toBe("TASK-0005P");
    } finally {
      db.close();
    }
  });

  test("prioritizes review work instead of reviewer work while failing checks exist", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005F",
      title: "Reviewer blocked by failing checks",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/53", source: "provider" } satisfies TaskPullRequest],
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({
          [reviewTask.id]: {
            provider: "github",
            pullRequestUrl: "https://github.com/acme/repo-a/pull/53",
            pullRequestNumber: 53,
            state: "open",
            isDraft: true,
            headSha: "rev-53",
            headBranch: "task-0005f",
            baseBranch: "main",
            headIntroducedAt: "2026-03-14T12:00:00Z",
            mergeState: "clean",
            reviewSummaries: [],
            conversationComments: [],
            reviewThreads: [],
            failingChecks: [{ name: "ci", state: "failure" }],
            pendingChecks: [{ name: "other-ci", state: "pending" }],
          },
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0005F");
    } finally {
      db.close();
    }
  });

  test("does not schedule review while a reviewer job is active for the same target", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005L",
      title: "Lease-conflicted review task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/54", source: "provider" } satisfies TaskPullRequest],
    });

    db.taskMirror.saveTasks([reviewTask]);
    const target = db.taskMirror.getTaskTarget(reviewTask.id, "repo-a");
    expect(target).not.toBeNull();
    db.jobs.createJob({
      taskId: reviewTask.id,
      taskTargetId: target!.id,
      taskProvider: reviewTask.provider,
      action: "reviewer",
      priorityRank: priorityToRank(reviewTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${reviewTask.id}:repo-a:reviewer`,
      selectionReason: "test active reviewer",
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({
          [reviewTask.id]: reviewContext({
            pullRequestUrl: "https://github.com/acme/repo-a/pull/54",
            pullRequestNumber: 54,
            state: "open",
            headBranch: "task-0005l",
            baseBranch: "main",
            failingChecks: [{ name: "ci", state: "failure" }],
          }),
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("does not schedule reviewer while a review job is active for the same target", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005M",
      title: "Lease-conflicted reviewer task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/55", source: "provider" } satisfies TaskPullRequest],
    });

    db.taskMirror.saveTasks([reviewTask]);
    const target = db.taskMirror.getTaskTarget(reviewTask.id, "repo-a");
    expect(target).not.toBeNull();
    db.jobs.createJob({
      taskId: reviewTask.id,
      taskTargetId: target!.id,
      taskProvider: reviewTask.provider,
      action: "review",
      priorityRank: priorityToRank(reviewTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${reviewTask.id}:repo-a:review`,
      selectionReason: "test active review",
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({
          [reviewTask.id]: reviewContext({
            pullRequestUrl: "https://github.com/acme/repo-a/pull/55",
            pullRequestNumber: 55,
            state: "open",
            headBranch: "task-0005m",
            baseBranch: "main",
          }),
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("prunes stale reviewer checkpoints and reselects reviewer work when PR state changes", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005C",
      title: "Reviewer checkpoint task",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/52", source: "provider" } satisfies TaskPullRequest],
    });

    const priorContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/52",
      pullRequestNumber: 52,
      state: "open",
      isDraft: true,
      headSha: "rev-52a",
      headBranch: "task-0005c",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [],
    };
    const currentContext: ReviewContext = {
      ...priorContext,
      headSha: "rev-52b",
    };

    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0];
    expect(worker).toBeDefined();
    db.taskMirror.saveTasks([reviewTask]);
    const reviewTarget = db.taskMirror.getTaskTarget(reviewTask.id, "repo-a");
    expect(reviewTarget).not.toBeNull();

    const reviewerJob = db.jobs.createJob({
      taskId: reviewTask.id,
      taskTargetId: reviewTarget!.id,
      taskProvider: reviewTask.provider,
      action: "reviewer",
      priorityRank: priorityToRank(reviewTask.priority),
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${reviewTask.id}:reviewer`,
      selectionReason: "test",
    });
    db.jobs.updateJobStatus(reviewerJob.id, "completed", { finishedAt: "2026-03-14T12:04:00Z" });
    const attempt = db.attempts.createAttemptWithLeases({
      jobId: reviewerJob.id,
      workerId: worker!.id,
      runnerName: "claude",
      runnerModel: "claude-opus-4-6",
      runnerVariant: "high",
      expiresAt: "2026-03-14T12:05:00Z",
      leases: [],
    });

    expect(attempt).not.toBeNull();
    db.reviewerCheckpoints.upsertReviewerCheckpoint({
      taskId: reviewTask.id,
      taskTargetId: reviewTarget!.id,
      prUrl: priorContext.pullRequestUrl,
      reviewContext: priorContext,
      sourceAttemptId: attempt!.id,
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({ [reviewTask.id]: currentContext }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("reviewer");
      expect(db.reviewerCheckpoints.getReviewerCheckpoint(reviewTarget!.id)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("does not reselect reviewer work when a new review summary appears on the same commit", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005S",
      title: "Reviewer checkpoint ignores new summary",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/54", source: "provider" } satisfies TaskPullRequest],
    });

    const priorContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/54",
      pullRequestNumber: 54,
      state: "open",
      isDraft: true,
      headSha: "rev-54",
      headBranch: "task-0005s",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [],
    };
    const currentContext: ReviewContext = {
      ...priorContext,
      reviewSummaries: [
        {
          id: "review-summary-1",
          body: "Please tighten validation here.",
          authorName: "reviewer",
          authoredByAgent: false,
          createdAt: "2026-03-14T12:05:00Z",
          commitId: priorContext.headSha,
          isCurrentHead: true,
        },
      ],
    };

    seedReviewerCheckpoint(db, reviewTask, priorContext);

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({ [reviewTask.id]: currentContext }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0005S");
      expect(db.reviewerCheckpoints.getReviewerCheckpoint(db.taskMirror.getTaskTarget(reviewTask.id, "repo-a")!.id)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("does not reselect reviewer work when thread activity changes on the same commit", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const reviewTask = task({
      id: "TASK-0005T",
      title: "Reviewer checkpoint ignores thread changes",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/55", source: "provider" } satisfies TaskPullRequest],
    });

    const priorContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/55",
      pullRequestNumber: 55,
      state: "open",
      isDraft: true,
      headSha: "rev-55",
      headBranch: "task-0005t",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T12:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [],
    };
    const currentContext: ReviewContext = {
      ...priorContext,
      conversationComments: [
        {
          id: "pr-comment-1",
          body: "Can you add coverage for this?",
          authorName: "reviewer",
          authoredByAgent: false,
          createdAt: "2026-03-14T12:06:00Z",
          isAfterCurrentHead: true,
          url: "https://github.com/acme/repo-a/pull/55#issuecomment-1",
        },
      ],
      reviewThreads: [
        {
          id: "thread-55",
          path: "src/example.ts",
          line: 15,
          isResolved: false,
          comments: [
            {
              id: "thread-comment-55",
              body: "This branch still needs a guard.",
              authorName: "reviewer",
              authoredByAgent: false,
              createdAt: "2026-03-14T12:07:00Z",
            },
          ],
        },
      ],
    };

    seedReviewerCheckpoint(db, reviewTask, priorContext);

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([reviewTask]),
        reviewService: new FakeReviewService({ [reviewTask.id]: currentContext }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0005T");
      expect(db.reviewerCheckpoints.getReviewerCheckpoint(db.taskMirror.getTaskTarget(reviewTask.id, "repo-a")!.id)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("blocks dependent chains until upstream tasks are in review with an open pull request or merged", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 4;

    const tasks = [
      task({
        id: "ENG-4746",
        title: "Root task",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:00:00Z",
      }),
      task({
        id: "ENG-4747",
        title: "Depends on 4746",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:01:00Z",
        dependencies: { taskIds: ["ENG-4746"], baseTaskId: null },
      }),
      task({
        id: "ENG-4748",
        title: "Depends on 4747",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:02:00Z",
        dependencies: { taskIds: ["ENG-4747"], baseTaskId: null },
      }),
      task({
        id: "ENG-4749",
        title: "Depends on 4748",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:03:00Z",
        dependencies: { taskIds: ["ENG-4748"], baseTaskId: null },
      }),
      task({
        id: "ENG-4750",
        title: "Depends on 4749",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:04:00Z",
        dependencies: { taskIds: ["ENG-4749"], baseTaskId: null },
      }),
    ];

    const taskSystem = new FakeTaskSystem(tasks);
    const reviewService = new FakeReviewService({});

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-4746");
      expect(result.jobs[0]?.action).toBe("execution");
      expect(taskSystem.comments.get("ENG-4747") ?? []).toHaveLength(0);
      expect(taskSystem.comments.get("ENG-4748") ?? []).toHaveLength(0);
      expect(taskSystem.comments.get("ENG-4749") ?? []).toHaveLength(0);
      expect(taskSystem.comments.get("ENG-4750") ?? []).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("skips dependent execution when a dependency has an unmapped provider state", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const dependentTask = task({
      id: "ENG-5048",
      title: "Depends on unmapped dependency",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T10:00:00Z",
      dependencies: { taskIds: ["ENG-5045"], baseTaskId: null },
    });
    const staleDependencyTask = task({
      id: "ENG-5045",
      title: "Previously mapped dependency",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      updatedAt: "2026-03-14T09:00:00Z",
    });
    const unrelatedTask = task({
      id: "ENG-5049",
      title: "Unrelated ready task",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      updatedAt: "2026-03-14T10:01:00Z",
    });
    db.taskMirror.saveTasks([staleDependencyTask]);
    const taskSystem = new FakeTaskSystem([dependentTask, unrelatedTask]);
    vi.spyOn(taskSystem, "getTask").mockImplementation(async (taskId) => {
      if (taskId === "ENG-5045") {
        throw new ForemanError("unknown_provider_state", "Unmapped provider state: Ready to Deploy");
      }
      if (taskId === dependentTask.id) {
        return dependentTask;
      }
      if (taskId === unrelatedTask.id) {
        return unrelatedTask;
      }
      throw new Error(`missing task ${taskId}`);
    });
    const reviewService = new FakeReviewService({});

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-5049");
      expect(result.jobs[0]?.action).toBe("execution");
      expect(taskSystem.comments.get("ENG-5048") ?? []).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("blocks dependent execution when the upstream pull request head branch is missing on origin", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    vi.spyOn(worktrees, "branchExistsOnOrigin").mockResolvedValue(false);

    const dependencyTask = task({
      id: "ENG-4680",
      title: "Dependency in review",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/10", source: "provider" } satisfies TaskPullRequest],
    });
    const dependentTask = task({
      id: "ENG-4681",
      title: "Dependent task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
        dependencies: { taskIds: ["ENG-4680"], baseTaskId: null },
    });

    const taskSystem = new FakeTaskSystem([dependencyTask, dependentTask]);
    const dependencyReviewContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/10",
      pullRequestNumber: 10,
      state: "open",
      isDraft: false,
      headSha: "abc",
      headBranch: "eng-4680",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T10:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [{ name: "ci", state: "pending" }],
    };
    seedReviewerCheckpoint(db, dependencyTask, dependencyReviewContext);
    const reviewService = new FakeReviewService({ [dependencyTask.id]: dependencyReviewContext });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
      expect(taskSystem.comments.get("ENG-4681") ?? []).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("uses branch-discovered dependency pull requests when the upstream task is in review without a linked artifact", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    vi.spyOn(worktrees, "branchExistsOnOrigin").mockResolvedValue(true);

    const dependencyTask = task({
      id: "ENG-4680",
      title: "Dependency in review",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
      pullRequests: [],
    });
    const dependentTask = task({
      id: "ENG-4681",
      title: "Dependent task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
        dependencies: { taskIds: ["ENG-4680"], baseTaskId: null },
    });

    const taskSystem = new FakeTaskSystem([dependencyTask, dependentTask]);
    const dependencyReviewContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/10",
      pullRequestNumber: 10,
      state: "open",
      isDraft: false,
      headSha: "abc",
      headBranch: "eng-4680",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T10:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [{ name: "ci", state: "pending" }],
    };
    seedReviewerCheckpoint(db, dependencyTask, dependencyReviewContext);
    const reviewService = new FakeReviewService({ [dependencyTask.id]: dependencyReviewContext });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-4681");
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.baseBranch).toBe("eng-4680");
      expect(taskSystem.comments.get("ENG-4681") ?? []).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("uses an explicit base branch instead of an inferred dependency pull request head", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    vi.spyOn(worktrees, "branchExistsOnOrigin").mockResolvedValue(true);

    const dependencyTask = task({
      id: "ENG-4680",
      title: "Dependency in review",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/10", source: "provider" } satisfies TaskPullRequest],
    });
    const dependentTask = task({
      id: "ENG-4681",
      title: "Dependent task with explicit base",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-4680"], baseTaskId: null },
      baseBranch: "release/base",
    });

    const taskSystem = new FakeTaskSystem([dependencyTask, dependentTask]);
    const dependencyReviewContext = reviewContext({
      pullRequestUrl: "https://github.com/acme/repo-a/pull/10",
      pullRequestNumber: 10,
      state: "open",
      headBranch: "eng-4680",
      baseBranch: "main",
      pendingChecks: [{ name: "ci", state: "pending" }],
    });
    seedReviewerCheckpoint(db, dependencyTask, dependencyReviewContext);
    const reviewService = new FakeReviewService({ [dependencyTask.id]: dependencyReviewContext });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-4681");
      expect(result.jobs[0]?.baseBranch).toBe("release/base");
    } finally {
      db.close();
    }
  });

  test("allows completed cross-repo dependencies without a matching repo target", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    const dependencyTask = task({
      id: "ENG-5282",
      title: "Completed frontend dependency",
      state: "done",
      providerState: "done",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
      targets: [{ repoKey: "lynk-frontend", branchName: "eng-5282", position: 0 }],
    });
    const dependentTask = task({
      id: "ENG-5304",
      title: "E2E dependent task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-5282"], baseTaskId: null },
      targets: [{ repoKey: "e2e", branchName: "eng-5304", position: 0 }],
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([dependencyTask, dependentTask]),
        reviewService: new FakeReviewService({}),
        repos: [
          { key: "e2e", rootPath: "/repos/e2e", defaultBranch: "main" },
          { key: "lynk-frontend", rootPath: "/repos/lynk-frontend", defaultBranch: "main" },
        ],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-5304");
      expect(result.jobs[0]?.target.repoKey).toBe("e2e");
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.baseBranch).toBe("main");
    } finally {
      db.close();
    }
  });

  test("keeps unresolved cross-repo dependencies blocking tasks without a matching repo target", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 2;

    const dependencyTask = task({
      id: "ENG-5282",
      title: "Unresolved frontend dependency",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
      targets: [{ repoKey: "lynk-frontend", branchName: "eng-5282", position: 0 }],
    });
    const dependentTask = task({
      id: "ENG-5304",
      title: "E2E dependent task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-5282"], baseTaskId: null },
      targets: [{ repoKey: "e2e", branchName: "eng-5304", position: 0 }],
    });

    db.taskMirror.saveTasks([dependencyTask]);
    const dependencyTarget = db.taskMirror.getTaskTarget("ENG-5282", "lynk-frontend");
    expect(dependencyTarget).not.toBeNull();
    db.jobs.createJob({
      taskId: dependencyTask.id,
      taskTargetId: dependencyTarget!.id,
      taskProvider: dependencyTask.provider,
      action: "execution",
      priorityRank: priorityToRank(dependencyTask.priority),
      repoKey: dependencyTarget!.repoKey,
      baseBranch: "main",
      dedupeKey: `${dependencyTask.id}:${dependencyTarget!.repoKey}:execution`,
      selectionReason: "test",
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([dependencyTask, dependentTask]),
        reviewService: new FakeReviewService({}),
        repos: [
          { key: "e2e", rootPath: "/repos/e2e", defaultBranch: "main" },
          { key: "lynk-frontend", rootPath: "/repos/lynk-frontend", defaultBranch: "main" },
        ],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("keeps unresolved dependencies blocking tasks with an explicit base branch", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    vi.spyOn(worktrees, "branchExistsOnOrigin").mockResolvedValue(true);

    const dependencyTask = task({
      id: "ENG-4680",
      title: "Unresolved dependency",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
    });
    const dependentTask = task({
      id: "ENG-4681",
      title: "Dependent task with explicit base",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-4680"], baseTaskId: null },
      baseBranch: "release/base",
    });

    const taskSystem = new FakeTaskSystem([dependencyTask, dependentTask]);

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-4680");
    } finally {
      db.close();
    }
  });

  test("allows explicit base branches with multiple completed dependencies and no base-from-task", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    vi.spyOn(worktrees, "branchExistsOnOrigin").mockResolvedValue(true);

    const firstDependency = task({
      id: "ENG-4690",
      title: "First completed dependency",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
    });
    const secondDependency = task({
      id: "ENG-4691",
      title: "Second completed dependency",
      state: "in_progress",
      providerState: "in_progress",
      priority: "normal",
      updatedAt: "2026-03-14T10:01:00Z",
    });
    const dependentTask = task({
      id: "ENG-4692",
      title: "Multi dependency with explicit base",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-4690", "ENG-4691"], baseTaskId: null },
      baseBranch: "release/base",
    });

    seedCompletedExecution(db, firstDependency);
    seedCompletedExecution(db, secondDependency);

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([firstDependency, secondDependency, dependentTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-4692");
      expect(result.jobs[0]?.baseBranch).toBe("release/base");
    } finally {
      db.close();
    }
  });

  test("requires non-base dependencies to be merged before scheduling multi-dependency execution", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    vi.spyOn(worktrees, "branchExistsOnOrigin").mockResolvedValue(true);

    const baseTask = task({
      id: "ENG-4700",
      title: "Base dependency",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/20", source: "provider" } satisfies TaskPullRequest],
    });
    const nonBaseTask = task({
      id: "ENG-4701",
      title: "Non-base dependency",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T10:01:00Z",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/21", source: "provider" } satisfies TaskPullRequest],
    });
    const dependentTask = task({
      id: "ENG-4702",
      title: "Multi-dependency task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
        dependencies: { taskIds: ["ENG-4700", "ENG-4701"], baseTaskId: "ENG-4700" },
    });

    const taskSystem = new FakeTaskSystem([baseTask, nonBaseTask, dependentTask]);
    const baseReviewContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/20",
      pullRequestNumber: 20,
      state: "open",
      isDraft: false,
      headSha: "abc",
      headBranch: "eng-4700",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T10:00:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [{ name: "ci", state: "pending" }],
    };
    const nonBaseReviewContext: ReviewContext = {
      provider: "github",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/21",
      pullRequestNumber: 21,
      state: "open",
      isDraft: false,
      headSha: "def",
      headBranch: "eng-4701",
      baseBranch: "main",
      headIntroducedAt: "2026-03-14T10:01:00Z",
      mergeState: "clean",
      reviewSummaries: [],
      conversationComments: [],
      reviewThreads: [],
      failingChecks: [],
      pendingChecks: [{ name: "ci", state: "pending" }],
    };
    seedReviewerCheckpoint(db, baseTask, baseReviewContext);
    seedReviewerCheckpoint(db, nonBaseTask, nonBaseReviewContext);
    const reviewService = new FakeReviewService({
      [baseTask.id]: baseReviewContext,
      [nonBaseTask.id]: nonBaseReviewContext,
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
      expect(taskSystem.comments.get("ENG-4702") ?? []).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("skips posting a blocker comment when it matches the latest existing comment", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const blockerBody = `${config.workspace.agentPrefix}Execution blocked because Agent Repo metadata is missing.`;

    const blockedTask = task({
      id: "TASK-0003",
      title: "Missing repo metadata",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T10:00:00Z",
      targets: [],
    });

    const taskSystem = new FakeTaskSystem([blockedTask]);
    taskSystem.comments.set(blockedTask.id, [
      {
        id: `${blockedTask.id}-1`,
        taskId: blockedTask.id,
        body: blockerBody,
        authorName: "agent",
        authorKind: "agent",
        createdAt: "2026-03-14T10:05:00Z",
        updatedAt: null,
      },
    ]);

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
      expect(taskSystem.comments.get(blockedTask.id) ?? []).toHaveLength(1);
      expect(taskSystem.comments.get(blockedTask.id)?.[0]?.body).toBe(blockerBody);
    } finally {
      db.close();
    }
  });

  test("fans out independent repo targets from one task", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 2;

    const multiTargetTask = task({
      id: "ENG-4774",
      title: "Multi-target task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T12:00:00Z",
      targets: [
        { repoKey: "repo-a", branchName: "eng-4774", position: 0 },
        { repoKey: "repo-b", branchName: "eng-4774", position: 1 },
      ],
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([multiTargetTask]),
        reviewService: new FakeReviewService({}),
        repos: [
          { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
          { key: "repo-b", rootPath: "/repos/repo-b", defaultBranch: "main" },
        ],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs.map((job) => `${job.action}:${job.target.repoKey}`)).toEqual([
        "execution:repo-a",
        "execution:repo-b",
      ]);
      expect(result.jobs.map((job) => job.baseBranch)).toEqual(["main", "main"]);
    } finally {
      db.close();
    }
  });

  test("waits for same-task repo dependencies before scheduling downstream targets", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 2;

    const multiTargetTask = task({
      id: "ENG-4775",
      title: "Sequenced multi-target task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T12:00:00Z",
      targets: [
        { repoKey: "repo-a", branchName: "eng-4775", position: 0 },
        { repoKey: "repo-b", branchName: "eng-4775", position: 1 },
      ],
      targetDependencies: [{ taskTargetRepoKey: "repo-b", dependsOnRepoKey: "repo-a", position: 0 }],
    });

    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0];
    expect(worker).toBeDefined();

    try {
      const initial = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([multiTargetTask]),
        reviewService: new FakeReviewService({}),
        repos: [
          { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
          { key: "repo-b", rootPath: "/repos/repo-b", defaultBranch: "main" },
        ],
        triggerType: "manual",
      });

      expect(initial.jobs).toHaveLength(1);
      expect(initial.jobs[0]?.target.repoKey).toBe("repo-a");

      const repoATarget = db.taskMirror.getTaskTarget(multiTargetTask.id, "repo-a");
      expect(repoATarget).not.toBeNull();
      const repoAJob = db.jobs.createJob({
        taskId: multiTargetTask.id,
        taskTargetId: repoATarget!.id,
        taskProvider: multiTargetTask.provider,
        action: "execution",
        priorityRank: priorityToRank(multiTargetTask.priority),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${multiTargetTask.id}:repo-a:execution`,
        selectionReason: "test",
      });
      db.jobs.updateJobStatus(repoAJob.id, "completed", { finishedAt: "2026-03-14T12:10:00Z" });
      const attempt = db.attempts.createAttemptWithLeases({
        jobId: repoAJob.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: "2026-03-14T12:20:00Z",
        leases: [],
      });
      expect(attempt).not.toBeNull();
      db.attempts.finalizeAttempt(attempt!.id, "completed", {
        finishedAt: "2026-03-14T12:10:00Z",
        summary: "repo-a complete",
      });

      const followUp = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([multiTargetTask]),
        reviewService: new FakeReviewService({}),
        repos: [
          { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
          { key: "repo-b", rootPath: "/repos/repo-b", defaultBranch: "main" },
        ],
        triggerType: "manual",
      });

      expect(followUp.jobs).toHaveLength(1);
      expect(followUp.jobs[0]?.target.repoKey).toBe("repo-b");
    } finally {
      db.close();
    }
  });

  test("schedules deployment tracking only when deployment instructions exist", async () => {
    const tempDir = await createTempDir("foreman-scout-deployment-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, tempDir);
    await fs.writeFile(path.join(tempDir, "deployment.md"), "Check production once.", "utf8");

    const deployableTask = task({
      id: "TASK-DEPLOY",
      title: "Deployable task",
      state: "deployable",
      providerState: "deployable",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    const reviewService = new FakeReviewService({
      [deployableTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/50",
        pullRequestNumber: 50,
        state: "merged",
        headBranch: "task-deploy",
        baseBranch: "main",
      }),
    });

    try {
      const active = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([deployableTask]),
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(active.jobs).toHaveLength(1);
      expect(active.jobs[0]?.action).toBe("deployment");
      expect(active.jobs[0]?.selectionContext).toMatchObject({
        deployment: { instructionBody: "Check production once." },
        pullRequestReference: { url: "https://github.com/acme/repo-a/pull/50", state: "merged" },
      });

      const inactiveRoot = await createTempDir("foreman-scout-deployment-missing-");
      cleanupDirs.push(inactiveRoot);
      const inactive = await runScoutSelection({
        config,
        paths: createWorkspacePaths(projectRoot, inactiveRoot),
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([deployableTask]),
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(inactive.jobs).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("honors deployment retry intervals and does not cap in-progress retries", async () => {
    const tempDir = await createTempDir("foreman-scout-deployment-retry-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, tempDir);
    await fs.writeFile(path.join(tempDir, "deployment.md"), "Check production once.", "utf8");

    const deployableTask = task({
      id: "TASK-DEPLOY-RETRY",
      title: "Deployable retry task",
      state: "deployable",
      providerState: "deployable",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    const reviewService = new FakeReviewService({
      [deployableTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/51",
        pullRequestNumber: 51,
        state: "merged",
        headBranch: "task-deploy-retry",
        baseBranch: "main",
      }),
    });
    db.taskMirror.saveTasks([deployableTask]);
    const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
    expect(target).not.toBeNull();

    try {
      db.deploymentTracking.upsertDeploymentRecord({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        repoKey: "repo-a",
        prUrl: "https://github.com/acme/repo-a/pull/51",
        prNumber: 51,
        prHeadBranch: "task-deploy-retry",
        prBaseBranch: "main",
        instructionHash: "a693920f695b5bbbcf0933b6a015f6c66b48a443293437b762912ff637ab5e64",
        instructionBody: "Check production once.",
        latestStatus: "in_progress",
        latestSummary: "Still rolling out",
        nextEligibleAt: "2999-01-01T00:00:00.000Z",
        retryCount: 99,
        blockedRetryCount: 99,
        createdFollowUpTaskIds: [],
        successful: false,
        sourceAttemptId: null,
      });

      const waiting = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([deployableTask]),
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(waiting.jobs).toHaveLength(0);

      db.deploymentTracking.upsertDeploymentRecord({
        taskId: deployableTask.id,
        taskTargetId: target!.id,
        repoKey: "repo-a",
        prUrl: "https://github.com/acme/repo-a/pull/51",
        prNumber: 51,
        prHeadBranch: "task-deploy-retry",
        prBaseBranch: "main",
        instructionHash: "a693920f695b5bbbcf0933b6a015f6c66b48a443293437b762912ff637ab5e64",
        instructionBody: "Check production once.",
        latestStatus: "in_progress",
        latestSummary: "Still rolling out",
        nextEligibleAt: "2000-01-01T00:00:00.000Z",
        retryCount: 99,
        blockedRetryCount: 99,
        createdFollowUpTaskIds: [],
        successful: false,
        sourceAttemptId: null,
      });

      const eligible = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([deployableTask]),
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(eligible.jobs.map((job) => job.action)).toEqual(["deployment"]);
    } finally {
      db.close();
    }
  });

  test("continues blocked deployment retries after prior blocked attempts", async () => {
    const tempDir = await createTempDir("foreman-scout-deployment-blocked-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, tempDir);
    await fs.writeFile(path.join(tempDir, "deployment.md"), "Check production once.", "utf8");

    const deployableTask = task({
      id: "TASK-DEPLOY-BLOCKED",
      title: "Deployable blocked task",
      state: "deployable",
      providerState: "deployable",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    const taskSystem = new FakeTaskSystem([deployableTask]);
    db.taskMirror.saveTasks([deployableTask]);
    const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
    expect(target).not.toBeNull();
    db.deploymentTracking.upsertDeploymentRecord({
      taskId: deployableTask.id,
      taskTargetId: target!.id,
      repoKey: "repo-a",
      prUrl: "https://github.com/acme/repo-a/pull/52",
      prNumber: 52,
      prHeadBranch: "task-deploy-blocked",
      prBaseBranch: "main",
      instructionHash: "a693920f695b5bbbcf0933b6a015f6c66b48a443293437b762912ff637ab5e64",
      instructionBody: "Check production once.",
      latestStatus: "blocked",
      latestSummary: "Provider unavailable",
      nextEligibleAt: "2000-01-01T00:00:00.000Z",
      retryCount: 2,
      blockedRetryCount: 2,
      createdFollowUpTaskIds: [],
      successful: false,
      sourceAttemptId: null,
    });

    try {
      const result = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem,
        reviewService: new FakeReviewService({
          [deployableTask.id]: reviewContext({
            pullRequestUrl: "https://github.com/acme/repo-a/pull/52",
            pullRequestNumber: 52,
            state: "merged",
            headBranch: "task-deploy-blocked",
            baseBranch: "main",
          }),
        }),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs.map((job) => job.action)).toEqual(["deployment"]);
      expect(taskSystem.comments.get(deployableTask.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("suppresses deployment retries while follow-up tasks are non-terminal", async () => {
    const tempDir = await createTempDir("foreman-scout-deployment-follow-up-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, tempDir);
    await fs.writeFile(path.join(tempDir, "deployment.md"), "Check production once.", "utf8");

    const deployableTask = task({
      id: "TASK-DEPLOY-FOLLOW-UP",
      title: "Deployable follow-up task",
      state: "deployable",
      providerState: "deployable",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
    });
    const childTask = task({
      id: "TASK-DEPLOY-CHILD",
      title: "Deployment child task",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      updatedAt: "2026-03-14T12:01:00Z",
    });
    const taskSystem = new FakeTaskSystem([deployableTask, childTask]);
    db.taskMirror.saveTasks([deployableTask]);
    const target = db.taskMirror.getTaskTarget(deployableTask.id, "repo-a");
    expect(target).not.toBeNull();
    db.deploymentTracking.upsertDeploymentRecord({
      taskId: deployableTask.id,
      taskTargetId: target!.id,
      repoKey: "repo-a",
      prUrl: "https://github.com/acme/repo-a/pull/53",
      prNumber: 53,
      prHeadBranch: "task-deploy-follow-up",
      prBaseBranch: "main",
      instructionHash: "a693920f695b5bbbcf0933b6a015f6c66b48a443293437b762912ff637ab5e64",
      instructionBody: "Check production once.",
      latestStatus: "follow_up_created",
      latestSummary: "Follow-up created",
      nextEligibleAt: null,
      retryCount: 0,
      blockedRetryCount: 0,
      createdFollowUpTaskIds: [childTask.id],
      successful: false,
      sourceAttemptId: null,
    });
    const reviewService = new FakeReviewService({
      [deployableTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/53",
        pullRequestNumber: 53,
        state: "merged",
        headBranch: "task-deploy-follow-up",
        baseBranch: "main",
      }),
    });

    try {
      const suppressed = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(suppressed.jobs.some((job) => job.action === "deployment")).toBe(false);

      childTask.state = "done";
      childTask.providerState = "done";
      const eligible = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });
      expect(eligible.jobs.map((job) => job.action)).toContain("deployment");
    } finally {
      db.close();
    }
  });

  const EXCLUDE_LABEL = "agent:disabled";

  // Builds one candidate per scout action (execution, review, retry, reviewer,
  // deployment, consolidation). When `excluded` is set, each carries the
  // configured exclude label so the intake chokepoint should drop them all.
  const buildExclusionScenario = (options: { excluded: boolean }): { tasks: Task[]; reviewService: FakeReviewService } => {
    const labels = options.excluded ? ["Agent", EXCLUDE_LABEL] : ["Agent"];
    const base = {
      priority: "normal" as const,
      updatedAt: "2026-03-14T12:00:00Z",
      labels,
    };

    const executionTask = task({ id: "TASK-EXC-EXEC", title: "Excludable execution task", state: "ready", providerState: "ready", ...base });
    const reviewTask = task({ id: "TASK-EXC-REVIEW", title: "Excludable review task", state: "in_review", providerState: "in_review", ...base });
    const retryTask = task({ id: "TASK-EXC-RETRY", title: "Excludable retry task", state: "in_review", providerState: "in_review", ...base });
    const reviewerTask = task({ id: "TASK-EXC-REVIEWER", title: "Excludable reviewer task", state: "in_review", providerState: "in_review", ...base });
    const deployableTask = task({ id: "TASK-EXC-DEPLOY", title: "Excludable deployment task", state: "deployable", providerState: "deployable", ...base });
    const consolidationTask = task({ id: "TASK-EXC-DONE", title: "Excludable consolidation task", state: "done", providerState: "done", ...base });

    const reviewService = new FakeReviewService({
      [reviewTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/61",
        pullRequestNumber: 61,
        state: "open",
        headBranch: "task-exc-review",
        baseBranch: "main",
        reviewSummaries: [
          { id: "rev-exc-1", body: "Please fix", authorName: "reviewer", authoredByAgent: false, createdAt: "2026-03-14T12:01:00Z", commitId: "abc", isCurrentHead: true },
        ],
      }),
      [retryTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/62",
        pullRequestNumber: 62,
        state: "closed",
        headBranch: "task-exc-retry",
        baseBranch: "main",
      }),
      [reviewerTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/63",
        pullRequestNumber: 63,
        state: "open",
        isDraft: true,
        headBranch: "task-exc-reviewer",
        baseBranch: "main",
      }),
      [deployableTask.id]: reviewContext({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/64",
        pullRequestNumber: 64,
        state: "merged",
        headBranch: "task-exc-deploy",
        baseBranch: "main",
      }),
    });

    return { tasks: [executionTask, reviewTask, retryTask, reviewerTask, deployableTask, consolidationTask], reviewService };
  };

  test("hard-skips tasks carrying an exclude label across every action type", async () => {
    const tempDir = await createTempDir("foreman-scout-exclude-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.excludeLabels = [EXCLUDE_LABEL];
    config.scheduler.workerConcurrency = 10;
    const paths = createWorkspacePaths(projectRoot, tempDir);
    await fs.writeFile(path.join(tempDir, "deployment.md"), "Check production once.", "utf8");

    const scenario = buildExclusionScenario({ excluded: true });
    const taskSystem = new FakeTaskSystem(scenario.tasks);

    try {
      const result = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem,
        reviewService: scenario.reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(0);
      expect(result.excludedByLabelCount).toBe(6);
      // Excluded tasks must not even be state-transitioned.
      expect(taskSystem.transitions).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("still selects every action when the exclude label is absent", async () => {
    const tempDir = await createTempDir("foreman-scout-exclude-absent-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.excludeLabels = [EXCLUDE_LABEL];
    config.scheduler.workerConcurrency = 10;
    config.scheduler.consolidateTerminalTasks = true;
    const paths = createWorkspacePaths(projectRoot, tempDir);
    await fs.writeFile(path.join(tempDir, "deployment.md"), "Check production once.", "utf8");

    const scenario = buildExclusionScenario({ excluded: false });

    try {
      const result = await runScoutSelection({
        config,
        paths,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem(scenario.tasks),
        reviewService: scenario.reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(new Set(result.jobs.map((job) => job.action))).toEqual(
        new Set(["execution", "review", "retry", "reviewer", "deployment", "consolidation"]),
      );
      expect(result.excludedByLabelCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test("does not filter when excludeLabels is empty", async () => {
    const tempDir = await createTempDir("foreman-scout-exclude-empty-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    // excludeLabels defaults to [] — a task carrying the would-be exclude label is still selected.

    const readyTask = task({
      id: "TASK-EXC-EMPTY",
      title: "Ready task with disabled-style label",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      updatedAt: "2026-03-14T12:00:00Z",
      labels: ["Agent", EXCLUDE_LABEL],
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem: new FakeTaskSystem([readyTask]),
        reviewService: new FakeReviewService({}),
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.task.id).toBe("TASK-EXC-EMPTY");
      expect(result.excludedByLabelCount).toBe(0);
    } finally {
      db.close();
    }
  });
});
