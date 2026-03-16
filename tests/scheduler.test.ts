import { describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/config.js";
import type { ReviewContext, Task, WorkerResult } from "../src/domain.js";
import { SchedulerService } from "../src/scheduler.js";

const sampleTask = (overrides: Partial<Task> = {}): Task => ({
  id: "TASK-0001",
  provider: "file",
  providerId: "TASK-0001",
  title: "Sample task",
  description: "",
  state: "in_review",
  providerState: "in_review",
  priority: "normal",
  labels: ["Agent"],
  assignee: null,
  repo: "repo-a",
  branchName: "task-0001",
  dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
  artifacts: [],
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
  ...overrides,
});

const baseWorkerResult = (overrides: Partial<WorkerResult> = {}): WorkerResult => ({
  schemaVersion: 1,
  action: "review",
  outcome: "completed",
  summary: "done",
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [],
  blockers: [],
  signals: [],
  ...overrides,
});

const reviewContext: ReviewContext = {
  provider: "github",
  pullRequestUrl: "https://github.com/acme/repo-a/pull/1",
  pullRequestNumber: 1,
  state: "open",
  isDraft: false,
  headSha: "abc123",
  headBranch: "task-0001",
  baseBranch: "main",
  headIntroducedAt: "2026-03-14T12:00:00Z",
  mergeState: "clean",
  actionableReviewSummaries: [],
  actionableConversationComments: [],
  unresolvedThreads: [],
  failingChecks: [],
  pendingChecks: [],
};

const fakeLogger = {
  child() {
    return this;
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
  line() {},
  runnerLine() {},
  flush: async () => undefined,
};

describe("SchedulerService applyWorkerResult", () => {
  test("swaps consolidation labels on completed consolidation jobs", async () => {
    const updateLabels = vi.fn(async () => undefined);
    const scheduler = new SchedulerService({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths: {
        projectRoot: "/tmp/project",
        workspaceRoot: "/tmp/workspace",
        configPath: "/tmp/workspace/foreman.workspace.yml",
        envPath: "/tmp/workspace/.env",
        dbPath: "/tmp/workspace/foreman.db",
        logsDir: "/tmp/workspace/logs",
        attemptsLogDir: "/tmp/workspace/logs/attempts",
        artifactsDir: "/tmp/workspace/artifacts",
        worktreesDir: "/tmp/workspace/worktrees",
        tasksDir: "/tmp/workspace/tasks",
        planPath: "/tmp/workspace/plan.md",
      },
      db: {
        ensureWorkerSlots: vi.fn(),
        addLearning: vi.fn(),
        updateLearning: vi.fn(),
        addAttemptEvent: vi.fn(),
        upsertReviewCheckpoint: vi.fn(),
      } as any,
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels,
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
      } as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await applyWorkerResult({
      attempt: { id: "attempt-1" },
      job: { action: "consolidation" },
      task: sampleTask({ state: "done", providerState: "done" }),
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
      workerResult: baseWorkerResult({ action: "consolidation", outcome: "completed" }),
    });

    expect(updateLabels).toHaveBeenCalledWith({
      taskId: "TASK-0001",
      add: ["Agent Consolidated"],
      remove: ["Agent"],
    });
  });

  test("records checkpoint write warnings without failing the attempt", async () => {
    const addAttemptEvent = vi.fn();
    const scheduler = new SchedulerService({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths: {
        projectRoot: "/tmp/project",
        workspaceRoot: "/tmp/workspace",
        configPath: "/tmp/workspace/foreman.workspace.yml",
        envPath: "/tmp/workspace/.env",
        dbPath: "/tmp/workspace/foreman.db",
        logsDir: "/tmp/workspace/logs",
        attemptsLogDir: "/tmp/workspace/logs/attempts",
        artifactsDir: "/tmp/workspace/artifacts",
        worktreesDir: "/tmp/workspace/worktrees",
        tasksDir: "/tmp/workspace/tasks",
        planPath: "/tmp/workspace/plan.md",
      },
      db: {
        ensureWorkerSlots: vi.fn(),
        addLearning: vi.fn(),
        updateLearning: vi.fn(),
        addAttemptEvent,
        upsertReviewCheckpoint: vi.fn(() => {
          throw new Error("checkpoint write failed");
        }),
      } as any,
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
      } as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-2" },
        job: { action: "review" },
        task: sampleTask({ artifacts: [{ type: "pull_request", url: reviewContext.pullRequestUrl }] }),
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          outcome: "no_action_needed",
          signals: ["review_checkpoint_eligible"],
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(addAttemptEvent).toHaveBeenCalledWith(
      "attempt-2",
      "review_checkpoint_warning",
      "checkpoint write failed",
    );
  });

  test("rejects execution results with code changes when no pull request mutation or artifact is present", async () => {
    const scheduler = new SchedulerService({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths: {
        projectRoot: "/tmp/project",
        workspaceRoot: "/tmp/workspace",
        configPath: "/tmp/workspace/foreman.workspace.yml",
        envPath: "/tmp/workspace/.env",
        dbPath: "/tmp/workspace/foreman.db",
        logsDir: "/tmp/workspace/logs",
        attemptsLogDir: "/tmp/workspace/logs/attempts",
        artifactsDir: "/tmp/workspace/artifacts",
        worktreesDir: "/tmp/workspace/worktrees",
        tasksDir: "/tmp/workspace/tasks",
        planPath: "/tmp/workspace/plan.md",
      },
      db: {
        ensureWorkerSlots: vi.fn(),
        addLearning: vi.fn(),
        updateLearning: vi.fn(),
        addAttemptEvent: vi.fn(),
        upsertReviewCheckpoint: vi.fn(),
      } as any,
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
      } as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3" },
        job: { action: "execution" },
        task: sampleTask({ state: "in_progress", providerState: "in_progress", artifacts: [] }),
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          action: "execution",
          outcome: "completed",
          signals: ["code_changed"],
        }),
      }),
    ).rejects.toThrow("Execution results with code changes must include a create_pull_request or reopen_pull_request mutation");
  });
});
