import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { priorityToRank, type RepoRef, type ResolvedPullRequest, type ReviewContext, type Task, type TaskArtifact, type TaskComment } from "../../domain/index.js";
import { runScoutSelection } from "../index.js";
import type { ReviewService } from "../../review/index.js";
import { FileTaskSystem } from "../../tasking/index.js";
import type { TaskSystem } from "../../tasking/index.js";
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

  async transition(): Promise<void> {}
  async addArtifact(): Promise<void> {}
  async updateLabels(): Promise<void> {}
}

class FakeReviewService implements ReviewService {
  constructor(private readonly contexts: Record<string, ReviewContext | null>) {}

  async resolvePullRequest(task: Task, _repo?: RepoRef, _target?: { repoKey: string; branchName: string }): Promise<ResolvedPullRequest | null> {
    const context = this.contexts[task.id];
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
    return this.contexts[task.id] ?? null;
  }

  async findLatestOpenPullRequestBranch(task: Task, _repo?: RepoRef, _target?: { repoKey: string; branchName: string }): Promise<string | null> {
    return this.contexts[task.id]?.state === "open" ? this.contexts[task.id]?.headBranch ?? null : null;
  }

  async createPullRequest(_input: { cwd: string; title: string; body: string; draft: boolean; baseBranch: string; headBranch: string }): Promise<{ url: string; number: number }> {
    throw new Error("not used");
  }

  async reopenPullRequest(_input: { cwd: string; pullRequestUrl?: string; pullRequestNumber?: number; draft: boolean; title?: string; body?: string }): Promise<{ url: string; number: number }> {
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
  repo: "repo-a",
  branchName: input.id.toLowerCase(),
  dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
  artifacts: [],
  url: null,
  ...input,
});

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
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/1" } satisfies TaskArtifact],
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
        pendingChecks: [],
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
      expect(db.taskMirror.getTask("TASK-0002")).toMatchObject({ id: "TASK-0002", repo: "repo-a", branchName: "task-0002" });
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
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/2" } satisfies TaskArtifact],
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
        pendingChecks: [],
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
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/2" } satisfies TaskArtifact],
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
        pendingChecks: [],
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
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/4" } satisfies TaskArtifact],
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
        dependencies: { taskIds: ["ENG-4746"], baseTaskId: null, branchNames: [] },
      }),
      task({
        id: "ENG-4748",
        title: "Depends on 4747",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:02:00Z",
        dependencies: { taskIds: ["ENG-4747"], baseTaskId: null, branchNames: [] },
      }),
      task({
        id: "ENG-4749",
        title: "Depends on 4748",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:03:00Z",
        dependencies: { taskIds: ["ENG-4748"], baseTaskId: null, branchNames: [] },
      }),
      task({
        id: "ENG-4750",
        title: "Depends on 4749",
        state: "ready",
        providerState: "ready",
        priority: "normal",
        updatedAt: "2026-03-14T10:04:00Z",
        dependencies: { taskIds: ["ENG-4749"], baseTaskId: null, branchNames: [] },
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
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/10" } satisfies TaskArtifact],
    });
    const dependentTask = task({
      id: "ENG-4681",
      title: "Dependent task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-4680"], baseTaskId: null, branchNames: [] },
    });

    const taskSystem = new FakeTaskSystem([dependencyTask, dependentTask]);
    const reviewService = new FakeReviewService({
      [dependencyTask.id]: {
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
        pendingChecks: [],
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
      artifacts: [],
    });
    const dependentTask = task({
      id: "ENG-4681",
      title: "Dependent task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-4680"], baseTaskId: null, branchNames: [] },
    });

    const taskSystem = new FakeTaskSystem([dependencyTask, dependentTask]);
    const reviewService = new FakeReviewService({
      [dependencyTask.id]: {
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
        pendingChecks: [],
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
      expect(result.jobs[0]?.task.id).toBe("ENG-4681");
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.baseBranch).toBe("eng-4680");
      expect(taskSystem.comments.get("ENG-4681") ?? []).toHaveLength(0);
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
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/20" } satisfies TaskArtifact],
    });
    const nonBaseTask = task({
      id: "ENG-4701",
      title: "Non-base dependency",
      state: "in_review",
      providerState: "in_review",
      priority: "normal",
      updatedAt: "2026-03-14T10:01:00Z",
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/21" } satisfies TaskArtifact],
    });
    const dependentTask = task({
      id: "ENG-4702",
      title: "Multi-dependency task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-4700", "ENG-4701"], baseTaskId: "ENG-4700", branchNames: [] },
    });

    const taskSystem = new FakeTaskSystem([baseTask, nonBaseTask, dependentTask]);
    const reviewService = new FakeReviewService({
      [baseTask.id]: {
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
        pendingChecks: [],
      },
      [nonBaseTask.id]: {
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
        pendingChecks: [],
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
      repo: null,
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

  test("uses a merged dependency pull request base branch when the dependency branch no longer exists", async () => {
    const tempDir = await createTempDir("foreman-scout-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;

    vi.spyOn(worktrees, "branchExistsOnOrigin").mockImplementation(async (_repo, branchName) => branchName !== "eng-4680");
    vi.spyOn(worktrees, "isAncestorOnOrigin").mockResolvedValue(true);

    const mergedDependency = task({
      id: "ENG-4680",
      title: "Merged dependency",
      state: "done",
      providerState: "done",
      priority: "normal",
      updatedAt: "2026-03-14T10:00:00Z",
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/10" } satisfies TaskArtifact],
    });
    const dependentTask = task({
      id: "ENG-4681",
      title: "Dependent task",
      state: "ready",
      providerState: "ready",
      priority: "high",
      updatedAt: "2026-03-14T11:00:00Z",
      dependencies: { taskIds: ["ENG-4680"], baseTaskId: null, branchNames: ["eng-4680"] },
    });

    const taskSystem = new FakeTaskSystem([mergedDependency, dependentTask]);
    const reviewService = new FakeReviewService({
      [mergedDependency.id]: {
        provider: "github",
        pullRequestUrl: "https://github.com/acme/repo-a/pull/10",
        pullRequestNumber: 10,
        state: "merged",
        isDraft: false,
        headSha: "abc",
        headBranch: "eng-4680",
        baseBranch: "master",
        headIntroducedAt: "2026-03-14T10:00:00Z",
        mergeState: "clean",
        reviewSummaries: [],
        conversationComments: [],
        reviewThreads: [],
        failingChecks: [],
        pendingChecks: [],
      },
    });

    try {
      const result = await runScoutSelection({
        config,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "master" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]?.task.id).toBe("ENG-4681");
      expect(result.jobs[0]?.action).toBe("execution");
      expect(result.jobs[0]?.baseBranch).toBe("master");
      expect(taskSystem.comments.get("ENG-4681") ?? []).toHaveLength(0);
      expect(worktrees.branchExistsOnOrigin).toHaveBeenCalledWith({ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "master" }, "eng-4680");
      expect(worktrees.isAncestorOnOrigin).toHaveBeenCalledWith({ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "master" }, "master", "master");
    } finally {
      db.close();
    }
  });
});
