import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ConversationComment, ReviewContext, Task, TaskArtifact, TaskComment } from "../src/domain.js";
import { runScoutSelection } from "../src/scout.js";
import type { ReviewService } from "../src/review/index.js";
import type { TaskSystem } from "../src/tasking/index.js";
import { createDefaultWorkspaceConfig } from "../src/config.js";
import * as worktrees from "../src/worktrees.js";
import { createMigratedDb, createTempDir } from "./helpers.js";

const cleanupDirs: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

  async getContext(task: Task, _agentPrefix: string): Promise<ReviewContext | null> {
    return this.contexts[task.id] ?? null;
  }

  async findLatestOpenPullRequestBranch(task: Task): Promise<string | null> {
    return this.contexts[task.id]?.state === "open" ? this.contexts[task.id]?.headBranch ?? null : null;
  }

  async listConversationComments(_prUrl: string): Promise<ConversationComment[]> {
    return [];
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
        actionableReviewSummaries: [{ id: "rev-1", body: "Please fix", authorName: "reviewer", createdAt: "2026-03-14T12:01:00Z", commitId: "abc" }],
        actionableConversationComments: [],
        unresolvedThreads: [],
        failingChecks: [],
        pendingChecks: [],
      },
    });

    try {
      const result = await runScoutSelection({
        config,
        db,
        taskSystem,
        reviewService,
        repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
        triggerType: "manual",
      });

      expect(result.jobs).toHaveLength(2);
      expect(result.jobs[0]?.action).toBe("review");
      expect(result.jobs[0]?.task.id).toBe("TASK-0002");
      expect(result.jobs[1]?.action).toBe("execution");
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
        actionableReviewSummaries: [],
        actionableConversationComments: [],
        unresolvedThreads: [],
        failingChecks: [],
        pendingChecks: [],
      },
    });

    try {
      const result = await runScoutSelection({
        config,
        db,
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
