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

  test("prefixes review replies and routes thread replies explicitly", async () => {
    const replyToReviewSummary = vi.fn(async () => undefined);
    const replyToThreadComment = vi.fn(async () => undefined);
    const replyToPrComment = vi.fn(async () => undefined);
    const resolveThreads = vi.fn(async () => undefined);
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
        replyToReviewSummary,
        replyToThreadComment,
        replyToPrComment,
        resolveThreads,
      } as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3b" },
        job: { action: "review" },
        task: sampleTask({ artifacts: [{ type: "pull_request", url: reviewContext.pullRequestUrl }] }),
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          reviewMutations: [
            { type: "reply_to_review_summary", reviewId: "review-1", body: "Looks good now" },
            { type: "reply_to_thread_comment", threadId: "thread-1", body: "[agent] Addressed in latest head" },
            { type: "reply_to_pr_comment", commentId: "comment-1", body: "Please take another look" },
            { type: "resolve_threads", threadIds: ["thread-1"] },
          ],
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(replyToReviewSummary).toHaveBeenCalledWith(reviewContext.pullRequestUrl, "review-1", "[agent] Looks good now");
    expect(replyToThreadComment).toHaveBeenCalledWith(reviewContext.pullRequestUrl, "thread-1", "[agent] Addressed in latest head");
    expect(replyToPrComment).toHaveBeenCalledWith(reviewContext.pullRequestUrl, "comment-1", "[agent] Please take another look");
    expect(resolveThreads).toHaveBeenCalledWith(reviewContext.pullRequestUrl, ["thread-1"]);
  });

  test("drains active worker runs during stop", async () => {
    const updateWorkerStatus = vi.fn();
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
        listWorkers: vi.fn(() => [
          {
            id: "worker-1",
            slot: 1,
            status: "running",
            currentAttemptId: "attempt-4",
            lastHeartbeatAt: "2026-03-16T00:00:00Z",
          },
        ]),
        updateWorkerStatus,
      } as any,
      taskSystem: {} as any,
      reviewService: {} as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    let resolveRun!: () => void;
    const activeRun = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const controller = new AbortController();
    (scheduler as any).status = "running";
    (scheduler as any).workerAbortControllers.set("worker-1", controller);
    (scheduler as any).activeWorkerRuns.set("worker-1", activeRun);

    const stopPromise = scheduler.stop();
    await Promise.resolve();

    expect(controller.signal.aborted).toBe(true);
    expect(updateWorkerStatus).toHaveBeenCalledWith("worker-1", "stopping", "attempt-4");

    resolveRun();
    await stopPromise;
  });

  test("does not redispatch workers that already have an in-flight run", async () => {
    const claimQueuedJobForWorker = vi.fn(() => true);
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
        listWorkers: vi.fn(() => [
          {
            id: "worker-1",
            slot: 1,
            status: "idle",
            currentAttemptId: null,
            lastHeartbeatAt: "2026-03-16T00:00:00Z",
          },
        ]),
        listJobsByStatus: vi.fn(() => [
          {
            id: "job-1",
            taskId: "TASK-0001",
            action: "execution",
            repoKey: "repo-a",
          },
        ]),
        claimQueuedJobForWorker,
      } as any,
      taskSystem: {} as any,
      reviewService: {} as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    let resolveRun!: () => void;
    const runPromise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const runJob = vi.fn(() => runPromise);
    (scheduler as any).runJob = runJob;
    (scheduler as any).status = "running";

    await (scheduler as any).dispatchQueuedJobs();
    await (scheduler as any).dispatchQueuedJobs();

    expect(claimQueuedJobForWorker).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledTimes(1);

    resolveRun();
    await runPromise;
  });

  test("returns leased job to queue when execution leases cannot be acquired", async () => {
    const updateWorkerStatus = vi.fn();
    const returnLeasedJobToQueue = vi.fn();
    const releaseLeaseByResource = vi.fn();
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
        createAttemptWithLeases: vi.fn(() => null),
        updateWorkerStatus,
        updateJobStatus: vi.fn(),
        addAttemptEvent: vi.fn(),
        releaseLeasesForAttempt: vi.fn(),
        returnLeasedJobToQueue,
        releaseLeaseByResource,
      } as any,
      taskSystem: {
        getTask: vi.fn(async () => sampleTask({ state: "in_progress", providerState: "in_progress" })),
      } as any,
      reviewService: {} as any,
      runner: {} as any,
      repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      env: {},
      logger: fakeLogger as any,
    });

    await (scheduler as any).runJob(
      {
        id: "worker-1",
        slot: 1,
        status: "leased",
        currentAttemptId: null,
        lastHeartbeatAt: "2026-03-16T00:00:00Z",
      },
      {
        id: "job-1",
        taskId: "TASK-0001",
        action: "execution",
        repoKey: "repo-a",
        baseBranch: "main",
      },
    );

    expect(returnLeasedJobToQueue).toHaveBeenCalledWith("job-1");
    expect(releaseLeaseByResource).not.toHaveBeenCalled();
    expect(updateWorkerStatus).toHaveBeenLastCalledWith("worker-1", "idle", null);
  });
});
