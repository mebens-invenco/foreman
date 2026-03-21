import { describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import type { ResolvedPullRequest, ReviewContext, Task, WorkerResult } from "../../domain/index.js";
import { SchedulerService } from "../index.js";
import * as worktrees from "../../workspace/git-worktrees.js";

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
  dependencies: { taskIds: [], baseTaskId: null },
  artifacts: [],
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
  ...overrides,
  targets:
    overrides.targets ??
    [{ repoKey: "repo-a", branchName: "task-0001", position: 0 }],
  targetDependencies: overrides.targetDependencies ?? [],
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
  reviewSummaries: [],
  conversationComments: [],
  reviewThreads: [],
  failingChecks: [],
  pendingChecks: [],
};

const resolvedPullRequest: ResolvedPullRequest = {
  pullRequestUrl: reviewContext.pullRequestUrl,
  pullRequestNumber: reviewContext.pullRequestNumber,
  state: reviewContext.state,
  isDraft: reviewContext.isDraft,
  headBranch: reviewContext.headBranch,
  baseBranch: reviewContext.baseBranch,
};

const sampleTarget = {
  id: "target-1",
  repoKey: "repo-a",
  branchName: "task-0001",
  position: 0,
};

const resolvePullRequestFromTask = async (task: Task, _repo?: unknown, _target?: unknown): Promise<ResolvedPullRequest | null> => {
  const artifactUrl = task.artifacts.find((artifact) => artifact.type === "pull_request")?.url;
  return artifactUrl ? { ...resolvedPullRequest, pullRequestUrl: artifactUrl } : null;
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

const createMockRepos = (overrides: Record<string, unknown> = {}): any => ({
  database: { close: vi.fn() },
  migrationRunner: { runMigrations: vi.fn(), importLegacyDatabase: vi.fn() },
  jobs: {
    activeJobCount: vi.fn(() => 0),
    hasActiveDedupeKey: vi.fn(() => false),
    createJob: vi.fn(),
    listQueue: vi.fn(() => []),
    listJobsByStatus: vi.fn(() => []),
    latestJobForTaskTarget: vi.fn(() => null),
    getJob: vi.fn(),
    updateJobStatus: vi.fn(),
    returnLeasedJobToQueue: vi.fn(),
    claimQueuedJobForWorker: vi.fn(() => true),
    ...((overrides.jobs as object | undefined) ?? {}),
  },
  attempts: {
    createAttempt: vi.fn(),
    createAttemptWithLeases: vi.fn(),
    finalizeAttempt: vi.fn(),
    listAttempts: vi.fn(() => []),
    getAttempt: vi.fn(),
    latestAttemptForJob: vi.fn(() => null),
    latestAttemptForTaskTarget: vi.fn(() => null),
    addAttemptEvent: vi.fn(),
    listAttemptEvents: vi.fn(() => []),
    recoverOrphanedRunningAttempts: vi.fn(() => []),
    ...((overrides.attempts as object | undefined) ?? {}),
  },
  workers: {
    ensureWorkerSlots: vi.fn(),
    listWorkers: vi.fn(() => []),
    updateWorkerStatus: vi.fn(),
    heartbeatWorker: vi.fn(),
    ...((overrides.workers as object | undefined) ?? {}),
  },
  leases: {
    acquireLease: vi.fn(() => true),
    releaseLeasesForAttempt: vi.fn(),
    releaseLeaseByResource: vi.fn(),
    hasActiveTaskLease: vi.fn(() => false),
    reapExpiredLeases: vi.fn(() => 0),
    ...((overrides.leases as object | undefined) ?? {}),
  },
  scoutRuns: {
    createScoutRun: vi.fn(),
    completeScoutRun: vi.fn(),
    listScoutRuns: vi.fn(() => []),
    ...((overrides.scoutRuns as object | undefined) ?? {}),
  },
  taskMirror: {
    getTask: vi.fn(() => null),
    getTaskTarget: vi.fn(() => null),
    getTaskTargetById: vi.fn(() => sampleTarget),
    getTargetsForTask: vi.fn(() => [sampleTarget]),
    getDependenciesForTask: vi.fn(() => []),
    getTargetDependenciesForTask: vi.fn(() => []),
    ...((overrides.taskMirror as object | undefined) ?? {}),
  },
  artifacts: {
    createArtifact: vi.fn(),
    listArtifacts: vi.fn(() => []),
    ...((overrides.artifacts as object | undefined) ?? {}),
  },
  reviewCheckpoints: {
    getReviewCheckpoint: vi.fn(() => null),
    upsertReviewCheckpoint: vi.fn(),
    deleteReviewCheckpoint: vi.fn(),
    ...((overrides.reviewCheckpoints as object | undefined) ?? {}),
  },
  learnings: {
    addLearning: vi.fn(),
    updateLearning: vi.fn(),
    searchLearnings: vi.fn(() => []),
    getLearningsByIds: vi.fn(() => []),
    listLearnings: vi.fn(() => []),
    ...((overrides.learnings as object | undefined) ?? {}),
  },
  history: {
    addHistoryStep: vi.fn(),
    listHistory: vi.fn(() => []),
    ...((overrides.history as object | undefined) ?? {}),
  },
  close: vi.fn(),
});

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
      foremanRepos: createMockRepos(),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels,
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
      } as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await applyWorkerResult({
      attempt: { id: "attempt-1" },
      job: { action: "consolidation", taskTargetId: sampleTarget.id },
      task: sampleTask({ state: "done", providerState: "done" }),
      target: sampleTarget,
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
      foremanRepos: createMockRepos({
        attempts: { addAttemptEvent },
        reviewCheckpoints: {
          upsertReviewCheckpoint: vi.fn(() => {
            throw new Error("checkpoint write failed");
          }),
        },
      }),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
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
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ artifacts: [{ type: "pull_request", url: reviewContext.pullRequestUrl }] }),
        target: sampleTarget,
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
      foremanRepos: createMockRepos(),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
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
        job: { action: "execution", taskTargetId: sampleTarget.id },
        task: sampleTask({ state: "in_progress", providerState: "in_progress", artifacts: [] }),
        target: sampleTarget,
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

  test("returns execution no-op tasks to in_review when an open pull request already exists", async () => {
    const transition = vi.fn(async () => undefined);
    const resolvePullRequest = vi.fn(async () => ({ ...resolvedPullRequest, state: "open" as const }));
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
      foremanRepos: createMockRepos(),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition,
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest,
      } as any,
      runner: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-4" },
        job: { action: "execution", taskTargetId: sampleTarget.id },
        task: sampleTask({
          state: "in_progress",
          providerState: "in_progress",
          artifacts: [{ type: "pull_request", url: reviewContext.pullRequestUrl }],
        }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          action: "execution",
          outcome: "no_action_needed",
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(resolvePullRequest).toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith({ taskId: "TASK-0001", toState: "in_review" });
  });

  test("prefixes review replies and routes thread replies explicitly", async () => {
    const replyToReviewSummary = vi.fn(async () => undefined);
    const replyToThreadComment = vi.fn(async () => undefined);
    const replyToPrComment = vi.fn(async () => undefined);
    const resolveThreads = vi.fn(async () => undefined);
    const resolvePullRequest = vi.fn(resolvePullRequestFromTask);
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
      foremanRepos: createMockRepos(),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        resolvePullRequest,
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
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ artifacts: [{ type: "pull_request", url: reviewContext.pullRequestUrl }] }),
        target: sampleTarget,
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
    expect(resolvePullRequest).toHaveBeenCalled();
  });

  test("uses centralized PR resolution for review mutations when the task has no PR artifact", async () => {
    const replyToThreadComment = vi.fn(async () => undefined);
    const resolveThreads = vi.fn(async () => undefined);
    const resolvePullRequest = vi.fn(async () => resolvedPullRequest);
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
      foremanRepos: createMockRepos(),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        addArtifact: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        resolvePullRequest,
        replyToThreadComment,
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
        attempt: { id: "attempt-3c" },
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ artifacts: [] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          reviewMutations: [
            { type: "reply_to_thread_comment", threadId: "thread-1", body: "Addressed in latest head" },
            { type: "resolve_threads", threadIds: ["thread-1"] },
          ],
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(resolvePullRequest).toHaveBeenCalledWith(sampleTask({ artifacts: [] }), {
      key: "repo-a",
      rootPath: "/repos/repo-a",
      defaultBranch: "main",
    }, sampleTarget);
    expect(replyToThreadComment).toHaveBeenCalledWith(reviewContext.pullRequestUrl, "thread-1", "[agent] Addressed in latest head");
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
      foremanRepos: createMockRepos({
        workers: {
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
        },
      }),
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

    expect(scheduler.getStatus().status).toBe("stopping");
    expect(controller.signal.aborted).toBe(true);
    expect(updateWorkerStatus).toHaveBeenCalledWith("worker-1", "stopping", "attempt-4");

    resolveRun();
    await stopPromise;
    expect(scheduler.getStatus().status).toBe("stopped");
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
      foremanRepos: createMockRepos({
        workers: {
          listWorkers: vi.fn(() => [
            {
              id: "worker-1",
              slot: 1,
              status: "idle",
              currentAttemptId: null,
              lastHeartbeatAt: "2026-03-16T00:00:00Z",
            },
          ]),
        },
        jobs: {
          listJobsByStatus: vi.fn(() => [
            {
              id: "job-1",
              taskId: "TASK-0001",
              action: "execution",
              repoKey: "repo-a",
            },
          ]),
          claimQueuedJobForWorker,
        },
      }),
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
      foremanRepos: createMockRepos({
        attempts: {
          createAttemptWithLeases: vi.fn(() => null),
        },
        workers: { updateWorkerStatus },
        jobs: { updateJobStatus: vi.fn(), returnLeasedJobToQueue },
        leases: { releaseLeasesForAttempt: vi.fn(), releaseLeaseByResource },
      }),
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

  test("does not transition a task to in_progress when worktree preparation fails", async () => {
    vi.spyOn(worktrees, "ensureTaskWorktree").mockRejectedValue(new Error("worktree setup failed"));

    const transition = vi.fn(async () => undefined);
    const finalizeAttempt = vi.fn();
    const updateJobStatus = vi.fn();
    const releaseLeasesForAttempt = vi.fn();
    const addAttemptEvent = vi.fn();
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
      foremanRepos: createMockRepos({
        attempts: {
          createAttemptWithLeases: vi.fn(() => ({
            id: "attempt-5",
            attemptNumber: 1,
            startedAt: "2026-03-16T00:00:00Z",
          })),
          addAttemptEvent,
          finalizeAttempt,
        },
        workers: { updateWorkerStatus },
        jobs: { updateJobStatus },
        leases: { releaseLeasesForAttempt },
      }),
      taskSystem: {
        getTask: vi.fn(async () => sampleTask({ state: "ready", providerState: "ready" })),
        transition,
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

    expect(transition).not.toHaveBeenCalled();
    expect(addAttemptEvent).toHaveBeenCalledWith("attempt-5", "attempt_started", "Started execution for TASK-0001");
    expect(addAttemptEvent).toHaveBeenCalledWith("attempt-5", "attempt_failed", "worktree setup failed");
    expect(finalizeAttempt).toHaveBeenCalledWith(
      "attempt-5",
      "failed",
      expect.objectContaining({ summary: "worktree setup failed", errorMessage: "worktree setup failed" }),
    );
    expect(updateJobStatus).toHaveBeenLastCalledWith(
      "job-1",
      "failed",
      expect.objectContaining({ errorMessage: "worktree setup failed" }),
    );
    expect(releaseLeasesForAttempt).toHaveBeenCalledWith("attempt-5", "completed");
    expect(updateWorkerStatus).toHaveBeenLastCalledWith("worker-1", "idle", null);
  });
});
