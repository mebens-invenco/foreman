import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import type { ResolvedPullRequest, ReviewContext, Task, WorkerResult } from "../../domain/index.js";
import { SchedulerService } from "../index.js";
import * as worktrees from "../../workspace/git-worktrees.js";
import { createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";

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
  pullRequests: [],
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
  ...overrides,
  targets:
    overrides.targets ??
    [{ repoKey: "repo-a", branchName: "task-0001", position: 0 }],
  targetDependencies: overrides.targetDependencies ?? [],
});

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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
  taskId: "TASK-0001",
  repoKey: "repo-a",
  branchName: "task-0001",
  position: 0,
};

const resolvePullRequestFromTask = async (task: Task, _repo?: unknown, _target?: unknown): Promise<ResolvedPullRequest | null> => {
  const pullRequestUrl = task.pullRequests.find((pullRequest) => pullRequest.repoKey === "repo-a")?.url;
  return pullRequestUrl ? { ...resolvedPullRequest, pullRequestUrl } : null;
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
  migrationRunner: { runMigrations: vi.fn() },
  jobs: {
    activeJobCount: vi.fn(() => 0),
    hasActiveDedupeKey: vi.fn(() => false),
    createJob: vi.fn(),
    createCronJob: vi.fn(),
    listQueue: vi.fn(() => []),
    listJobsByStatus: vi.fn(() => []),
    latestJobForDedupeKey: vi.fn(() => null),
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
    linkRunnerSession: vi.fn(),
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
    saveTasks: vi.fn(),
    upsertTaskPullRequest: vi.fn(),
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
    getArtifact: vi.fn(),
    listArtifacts: vi.fn(() => []),
    ...((overrides.artifacts as object | undefined) ?? {}),
  },
  reviewCheckpoints: {
    getReviewCheckpoint: vi.fn(() => null),
    upsertReviewCheckpoint: vi.fn(),
    deleteReviewCheckpoint: vi.fn(),
    ...((overrides.reviewCheckpoints as object | undefined) ?? {}),
  },
  reviewerCheckpoints: {
    getReviewerCheckpoint: vi.fn(() => null),
    upsertReviewerCheckpoint: vi.fn(),
    deleteReviewerCheckpoint: vi.fn(),
    ...((overrides.reviewerCheckpoints as object | undefined) ?? {}),
  },
  learnings: {
    addLearning: vi.fn(),
    updateLearning: vi.fn(),
    searchLearnings: vi.fn(() => []),
    getLearningsByIds: vi.fn(() => []),
    listLearnings: vi.fn(() => []),
    ...((overrides.learnings as object | undefined) ?? {}),
  },
  runnerSessions: {
    getActiveSession: vi.fn(() => null),
    createSession: vi.fn(() => ({ id: "runner-session-1", nativeSessionId: null })),
    updateSession: vi.fn(),
    linkRunnerSession: vi.fn(),
    ...((overrides.runnerSessions as object | undefined) ?? {}),
  },
  close: vi.fn(),
});

describe("SchedulerService cron scheduling", () => {
  test("does not discover cron jobs when cron scheduling is disabled", async () => {
    const workspaceRoot = await createTempDir("foreman-scheduler-cron-test-");
    cleanupDirs.push(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "cron"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "cron", "check.md"), "---\ninterval: 15m\n---\nCheck.");
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.cron.enabled = false;
    const foremanRepos = createMockRepos();
    const scheduler = new SchedulerService({
      config,
      paths: createWorkspacePaths(testProjectRoot, workspaceRoot),
      foremanRepos,
      taskSystem: {} as any,
      reviewService: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    await (scheduler as any).scheduleDueCronJobs();

    expect(foremanRepos.jobs.createCronJob).not.toHaveBeenCalled();
  });

  test("dedupes cron scheduling when an active run exists", async () => {
    const workspaceRoot = await createTempDir("foreman-scheduler-cron-test-");
    cleanupDirs.push(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "cron"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "cron", "check.md"), "---\ninterval: 15m\n---\nCheck.");
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.cron.enabled = true;
    const foremanRepos = createMockRepos({
      jobs: { hasActiveDedupeKey: vi.fn(() => true) },
    });
    const scheduler = new SchedulerService({
      config,
      paths: createWorkspacePaths(testProjectRoot, workspaceRoot),
      foremanRepos,
      taskSystem: {} as any,
      reviewService: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    await (scheduler as any).scheduleDueCronJobs();

    expect(foremanRepos.jobs.hasActiveDedupeKey).toHaveBeenCalledWith("cron:cron/check.md");
    expect(foremanRepos.jobs.createCronJob).not.toHaveBeenCalled();
  });
});

describe("SchedulerService orphan recovery", () => {
  test("reaps expired leases before startup recovery", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const reapExpiredLeases = vi.fn(() => {
      order.push("reap");
      return 2;
    });
    const recoverOrphanedRunningAttempts = vi.fn(() => {
      order.push("recover");
      return [{ attemptId: "attempt-1", jobId: "job-1", workerId: "worker-1" }];
    });
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
        attempts: { recoverOrphanedRunningAttempts },
        leases: { reapExpiredLeases },
      }),
      taskSystem: {} as any,
      reviewService: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });
    const attemptChanged = vi.fn();
    const workerUpdated = vi.fn();
    scheduler.on("attempt_changed", attemptChanged);
    scheduler.on("worker_updated", workerUpdated);

    try {
      await scheduler.start();

      expect(order).toEqual(["reap", "recover"]);
      expect(recoverOrphanedRunningAttempts).toHaveBeenCalledWith(
        "Recovered abandoned attempt on scheduler startup after prior shutdown",
        {},
      );
      expect(attemptChanged).toHaveBeenCalledWith({ attemptId: "attempt-1", status: "canceled" });
      expect(workerUpdated).toHaveBeenCalledWith({ workerId: "worker-1", status: "idle" });
    } finally {
      (scheduler as any).clearTimers();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("recovers after periodic lease reaping while excluding active workers", async () => {
    vi.useFakeTimers();
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.scoutPollIntervalSeconds = 999;
    config.scheduler.schedulerLoopIntervalMs = 999_000;
    config.scheduler.staleLeaseReapIntervalSeconds = 1;
    const reapExpiredLeases = vi.fn(() => 1);
    const recoverOrphanedRunningAttempts = vi.fn(() => []);
    const scheduler = new SchedulerService({
      config,
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
        attempts: { recoverOrphanedRunningAttempts },
        leases: { reapExpiredLeases },
      }),
      taskSystem: {} as any,
      reviewService: {} as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    try {
      (scheduler as any).status = "running";
      (scheduler as any).activeWorkerRuns.set("worker-active", Promise.resolve());
      (scheduler as any).armTimers();

      await vi.advanceTimersByTimeAsync(1000);

      expect(recoverOrphanedRunningAttempts).toHaveBeenCalledWith(
        "Recovered abandoned attempt after stale leases expired",
        { excludeWorkerIds: ["worker-active"] },
      );
    } finally {
      (scheduler as any).clearTimers();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("SchedulerService scout timeout", () => {
  test("marks a hung scout run failed and rearms polling", async () => {
    vi.useFakeTimers();
    const timeoutMs = 5 * 60 * 1000;
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.scheduler.workerConcurrency = 1;
    config.scheduler.schedulerLoopIntervalMs = 999_000;
    config.scheduler.staleLeaseReapIntervalSeconds = 999_000;
    const completeScoutRun = vi.fn();
    const foremanRepos = createMockRepos({
      scoutRuns: {
        createScoutRun: vi.fn(() => "scout-1"),
        completeScoutRun,
        listScoutRuns: vi.fn(() => [
          {
            id: "scout-1",
            triggerType: "poll",
            status: "running",
            startedAt: "2026-03-16T00:00:00Z",
            finishedAt: null,
            selectedAction: null,
            selectedTaskId: null,
            candidateCount: 1,
            activeCount: 1,
            terminalCount: 0,
          },
        ]),
      },
    });
    const scheduler = new SchedulerService({
      config,
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
      foremanRepos,
      taskSystem: {
        listCandidates: vi.fn(async () => [sampleTask()]),
      } as any,
      reviewService: {
        resolvePullRequest: vi.fn(() => new Promise<ResolvedPullRequest | null>(() => undefined)),
        getContext: vi.fn(() => new Promise<ReviewContext>(() => undefined)),
      } as any,
      repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      env: {},
      logger: fakeLogger as any,
    });

    try {
      (scheduler as any).status = "running";
      const runPromise = (scheduler as any).runScout("poll") as Promise<void>;

      await vi.advanceTimersByTimeAsync(timeoutMs);
      await runPromise;

      expect(completeScoutRun).toHaveBeenCalledWith({
        id: "scout-1",
        status: "failed",
        errorMessage: `Scout selection timed out after ${timeoutMs}ms`,
        summary: { error: `Scout selection timed out after ${timeoutMs}ms` },
      });
      expect((scheduler as any).scoutInFlight).toBe(false);
      expect(scheduler.getStatus().nextScoutPollAt).not.toBeNull();
    } finally {
      (scheduler as any).clearTimers();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
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
          upsertPullRequest: vi.fn(async () => undefined),
          transition: vi.fn(async () => undefined),
          updateLabels,
        } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
      } as any,
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
          upsertPullRequest: vi.fn(async () => undefined),
          transition: vi.fn(async () => undefined),
          updateLabels: vi.fn(async () => undefined),
        } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-2" },
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          outcome: "no_action_needed",
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(addAttemptEvent).toHaveBeenCalledWith(
      "attempt-2",
      "review_checkpoint_warning",
      "checkpoint write failed",
    );
  });

  test("uses the worker review snapshot when saving a checkpoint", async () => {
    const upsertReviewCheckpoint = vi.fn();
    const getContext = vi.fn(async () => ({
      ...reviewContext,
      headSha: "different-head",
    }));
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
        reviewCheckpoints: { upsertReviewCheckpoint },
      }),
        taskSystem: {
          addComment: vi.fn(async () => undefined),
          upsertPullRequest: vi.fn(async () => undefined),
          transition: vi.fn(async () => undefined),
          updateLabels: vi.fn(async () => undefined),
        } as any,
      reviewService: {
        getContext,
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-2b" },
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        reviewContext,
        workerResult: baseWorkerResult({
          outcome: "no_action_needed",
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(getContext).not.toHaveBeenCalled();
    expect(upsertReviewCheckpoint).toHaveBeenCalledWith({
      taskId: "TASK-0001",
      taskTargetId: sampleTarget.id,
      prUrl: reviewContext.pullRequestUrl,
      reviewContext,
      sourceAttemptId: "attempt-2b",
    });
  });

  test("saves a review checkpoint for blocked review attempts", async () => {
    const addComment = vi.fn(async () => undefined);
    const upsertReviewCheckpoint = vi.fn();
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
        reviewCheckpoints: { upsertReviewCheckpoint },
      }),
      taskSystem: {
        addComment,
        upsertPullRequest: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-2c" },
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          outcome: "blocked",
          blockers: ["Check logs are unavailable."],
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(addComment).toHaveBeenCalledWith({
      taskId: "TASK-0001",
      body: "[agent] Check logs are unavailable.",
    });
    expect(upsertReviewCheckpoint).toHaveBeenCalledWith({
      taskId: "TASK-0001",
      taskTargetId: sampleTarget.id,
      prUrl: reviewContext.pullRequestUrl,
      reviewContext,
      sourceAttemptId: "attempt-2c",
    });
  });

  test("submits reviewer comment reviews with the reviewer prefix", async () => {
    const submitPullRequestReview = vi.fn(async () => undefined);
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
        upsertPullRequest: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
        submitPullRequestReview,
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-2c" },
        job: { action: "reviewer", taskTargetId: sampleTarget.id },
        task: sampleTask({ pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          action: "reviewer",
          reviewMutations: [
            {
              type: "submit_pull_request_review",
              body: "Please add coverage for this branch.",
              event: "COMMENT",
              comments: [{ path: "src/example.ts", line: 12, body: "Guard this branch." }],
            },
          ],
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(submitPullRequestReview).toHaveBeenCalledWith(reviewContext.pullRequestUrl, {
      body: "[review agent] Please add coverage for this branch.",
      event: "COMMENT",
      comments: [{ path: "src/example.ts", line: 12, body: "[review agent] Guard this branch." }],
    });
  });

  test("uses the worker review snapshot when saving a reviewer checkpoint", async () => {
    const upsertReviewerCheckpoint = vi.fn();
    const getContext = vi.fn(async () => ({
      ...reviewContext,
      headSha: "different-head",
    }));
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
        reviewerCheckpoints: { upsertReviewerCheckpoint },
      }),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        upsertPullRequest: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        getContext,
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-2d" },
        job: { action: "reviewer", taskTargetId: sampleTarget.id },
        task: sampleTask({ pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        reviewContext,
        workerResult: baseWorkerResult({
          action: "reviewer",
          outcome: "no_action_needed",
        }),
      }),
    ).resolves.toBe(reviewContext.pullRequestUrl);

    expect(getContext).not.toHaveBeenCalled();
    expect(upsertReviewerCheckpoint).toHaveBeenCalledWith({
      taskId: "TASK-0001",
      taskTargetId: sampleTarget.id,
      prUrl: reviewContext.pullRequestUrl,
      reviewContext,
      sourceAttemptId: "attempt-2d",
    });
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
          upsertPullRequest: vi.fn(async () => undefined),
          transition: vi.fn(async () => undefined),
          updateLabels: vi.fn(async () => undefined),
        } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest: vi.fn(resolvePullRequestFromTask),
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3" },
        job: { action: "execution", taskTargetId: sampleTarget.id },
        task: sampleTask({ state: "in_progress", providerState: "in_progress", pullRequests: [] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          action: "execution",
          outcome: "completed",
          signals: ["code_changed"],
        }),
      }),
    ).rejects.toThrow("Execution results with code changes must include a create_pull_request mutation");
  });

  test("records created pull requests through the task system and task mirror", async () => {
    const upsertPullRequest = vi.fn(async () => undefined);
    const upsertTaskPullRequest = vi.fn();
    const createPullRequest = vi.fn(async () => ({ url: "https://github.com/acme/repo-a/pull/2", number: 2 }));
    const transition = vi.fn(async () => undefined);
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
      foremanRepos: createMockRepos({ taskMirror: { upsertTaskPullRequest } }),
      taskSystem: {
        addComment: vi.fn(async () => undefined),
        upsertPullRequest,
        transition,
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        createPullRequest,
        resolvePullRequest: vi.fn(async () => null),
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3a" },
        job: { action: "execution", taskTargetId: sampleTarget.id },
        task: sampleTask({ state: "in_progress", providerState: "in_progress", pullRequests: [] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          action: "execution",
          outcome: "completed",
          signals: ["code_changed"],
          reviewMutations: [
            {
              type: "create_pull_request",
              title: "TASK-0001: Sample task",
              body: "## Summary\n- Adds the implementation.",
              draft: true,
              baseBranch: "main",
              headBranch: "task-0001",
            },
          ],
        }),
      }),
    ).resolves.toBe("https://github.com/acme/repo-a/pull/2");

    const pullRequest = {
      repoKey: "repo-a",
      url: "https://github.com/acme/repo-a/pull/2",
      title: "TASK-0001: Sample task",
      source: "local",
    };
    expect(upsertPullRequest).toHaveBeenCalledWith({ taskId: "TASK-0001", pullRequest });
    expect(upsertTaskPullRequest).toHaveBeenCalledWith({ taskId: "TASK-0001", pullRequest });
    expect(transition).toHaveBeenCalledWith({ taskId: "TASK-0001", toState: "in_review" });
  });

  test("records identifiers for tasks created from worker mutations", async () => {
    const createTask = vi.fn(async () => ({ id: "TASK-0002", providerId: "TASK-0002", url: null }));
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
      foremanRepos: createMockRepos({ attempts: { addAttemptEvent } }),
      taskSystem: {
        createTask,
        addComment: vi.fn(async () => undefined),
        upsertPullRequest: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        resolvePullRequest: vi.fn(async () => null),
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;
    const task = sampleTask({ state: "in_progress", providerState: "in_progress", pullRequests: [] });
    const mutation = {
      type: "create_task" as const,
      title: "Follow-up task",
      description: "Do the follow-up work.",
      repos: ["repo-a"],
    };

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3c" },
        job: { action: "execution", taskTargetId: sampleTarget.id },
        task,
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          action: "execution",
          outcome: "completed",
          taskMutations: [mutation],
        }),
      }),
    ).resolves.toBeNull();

    expect(createTask).toHaveBeenCalledWith({ parentTask: task, mutation });
    expect(addAttemptEvent).toHaveBeenCalledWith(
      "attempt-3c",
      "task_created",
      JSON.stringify({ taskId: "TASK-0002", providerId: "TASK-0002", url: null }),
    );
  });

  test("keeps created pull requests in the task mirror when Linear PR sync fails", async () => {
    const upsertPullRequest = vi.fn(async () => {
      throw new Error("Linear request failed: 502 Bad Gateway");
    });
    const upsertTaskPullRequest = vi.fn();
    const createPullRequest = vi.fn(async () => ({ url: "https://github.com/acme/repo-a/pull/2", number: 2 }));
    const transition = vi.fn(async () => undefined);
    const warn = vi.fn();
    const scheduler = new SchedulerService({
      config: createDefaultWorkspaceConfig("foo", "linear"),
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
      foremanRepos: createMockRepos({ taskMirror: { upsertTaskPullRequest } }),
      taskSystem: {
        getProvider: vi.fn(() => "linear"),
        addComment: vi.fn(async () => undefined),
        upsertPullRequest,
        transition,
        updateLabels: vi.fn(async () => undefined),
      } as any,
      reviewService: {
        createPullRequest,
        resolvePullRequest: vi.fn(async () => null),
      } as any,
      repos: [],
      env: {},
      logger: {
        ...fakeLogger,
        child() {
          return this;
        },
        warn,
      } as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3b" },
        job: { action: "execution", taskTargetId: sampleTarget.id },
        task: sampleTask({ state: "in_progress", providerState: "in_progress", pullRequests: [] }),
        target: sampleTarget,
        repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        worktreePath: "/tmp/workspace/worktrees/repo-a/TASK-0001",
        workerResult: baseWorkerResult({
          action: "execution",
          outcome: "completed",
          signals: ["code_changed"],
          reviewMutations: [
            {
              type: "create_pull_request",
              title: "TASK-0001: Sample task",
              body: "## Summary\n- Adds the implementation.",
              draft: true,
              baseBranch: "main",
              headBranch: "task-0001",
            },
          ],
        }),
      }),
    ).resolves.toBe("https://github.com/acme/repo-a/pull/2");

    const pullRequest = {
      repoKey: "repo-a",
      url: "https://github.com/acme/repo-a/pull/2",
      title: "TASK-0001: Sample task",
      source: "local",
    };
    expect(upsertTaskPullRequest).toHaveBeenCalledWith({ taskId: "TASK-0001", pullRequest });
    expect(upsertPullRequest).toHaveBeenCalledWith({ taskId: "TASK-0001", pullRequest });
    expect(transition).toHaveBeenCalledWith({ taskId: "TASK-0001", toState: "in_review" });
    expect(warn).toHaveBeenCalledWith("failed to sync pull request with Linear task provider", {
      taskId: "TASK-0001",
      repoKey: "repo-a",
      pullRequestUrl: "https://github.com/acme/repo-a/pull/2",
      source: "local",
      error: "Linear request failed: 502 Bad Gateway",
    });
  });

  test("returns execution no-op tasks to in_review when an open pull request already exists", async () => {
    const transition = vi.fn(async () => undefined);
    const upsertPullRequest = vi.fn(async () => undefined);
    const upsertTaskPullRequest = vi.fn();
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
      foremanRepos: createMockRepos({ taskMirror: { upsertTaskPullRequest } }),
        taskSystem: {
          addComment: vi.fn(async () => undefined),
          upsertPullRequest,
          transition,
          updateLabels: vi.fn(async () => undefined),
        } as any,
      reviewService: {
        getContext: vi.fn(async () => reviewContext),
        resolvePullRequest,
      } as any,
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
          pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }],
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
    const pullRequest = {
      repoKey: "repo-a",
      url: reviewContext.pullRequestUrl,
      source: "branch_inferred",
    };
    expect(upsertPullRequest).toHaveBeenCalledWith({ taskId: "TASK-0001", pullRequest });
    expect(upsertTaskPullRequest).toHaveBeenCalledWith({ taskId: "TASK-0001", pullRequest });
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
          upsertPullRequest: vi.fn(async () => undefined),
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
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3b" },
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }] }),
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
          upsertPullRequest: vi.fn(async () => undefined),
          transition: vi.fn(async () => undefined),
          updateLabels: vi.fn(async () => undefined),
        } as any,
      reviewService: {
        resolvePullRequest,
        replyToThreadComment,
        resolveThreads,
      } as any,
      repos: [],
      env: {},
      logger: fakeLogger as any,
    });

    const applyWorkerResult = (scheduler as any).applyWorkerResult.bind(scheduler) as (input: unknown) => Promise<string | null>;

    await expect(
      applyWorkerResult({
        attempt: { id: "attempt-3c" },
        job: { action: "review", taskTargetId: sampleTarget.id },
        task: sampleTask({ pullRequests: [] }),
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

    expect(resolvePullRequest).toHaveBeenCalledWith(sampleTask({ pullRequests: [] }), {
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
        taskTargetId: sampleTarget.id,
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
        taskTargetId: sampleTarget.id,
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

  test("uses fresh reviewer sessions after retry", async () => {
    const tempDir = await createTempDir("foreman-session-routing-test-");
    const paths = createWorkspacePaths(testProjectRoot, tempDir);
    const worktreePath = path.join(tempDir, "worktree");
    const fakeRunnerPath = path.join(tempDir, "fake-opencode.js");
    const promptOut = path.join(tempDir, "prompt.md");
    const argvOut = path.join(tempDir, "argv.json");
    const originalOpencodeBin = process.env.FOREMAN_OPENCODE_BIN;
    const ensureTaskWorktree = vi.spyOn(worktrees, "ensureTaskWorktree").mockResolvedValue(worktreePath);

    try {
      await fs.mkdir(worktreePath, { recursive: true });
      await fs.writeFile(
        fakeRunnerPath,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          "let prompt = '';",
          "process.stdin.on('data', (chunk) => { prompt += chunk; });",
          "process.stdin.on('end', () => {",
          "  fs.writeFileSync(process.env.FOREMAN_TEST_PROMPT_OUT, prompt);",
          "  const argv = process.argv.slice(2);",
          "  fs.writeFileSync(process.env.FOREMAN_TEST_ARGV_OUT, JSON.stringify(argv));",
          "  const action = prompt.includes('# Retry Prompt') ? 'retry' : prompt.includes('# Reviewer Prompt') || prompt.includes('Review the latest PR changes.') ? 'reviewer' : 'review';",
          "  const sessionFlag = argv.indexOf('--session');",
          "  const sessionID = sessionFlag >= 0 ? argv[sessionFlag + 1] : action + '-fresh-session';",
          "  const result = '<agent-result>' + JSON.stringify({ schemaVersion: 1, action, outcome: 'no_action_needed', summary: 'done', taskMutations: [], reviewMutations: [], learningMutations: [], blockers: [], signals: [] }) + '</agent-result>';",
          "  process.stdout.write(JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text: result } }));",
          "});",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.FOREMAN_OPENCODE_BIN = fakeRunnerPath;

      const config = createDefaultWorkspaceConfig("foo", "file");
      config.runner.reviewer = { ...config.runner.execution };
      const activeSessions = new Map<string, any>([
        [
          "implementation",
          {
            id: "implementation-session",
            taskTargetId: sampleTarget.id,
            role: "implementation",
            runnerName: "opencode",
            runnerModel: config.runner.execution.model,
            runnerVariant: "high",
            nativeSessionId: "implementation-native-session",
            isActive: true,
            lastAttemptId: "attempt-execution",
            lastWorktreeHeadSha: "execution-head",
            lastReviewHeadSha: null,
            createdAt: "2026-03-16T00:00:00Z",
            updatedAt: "2026-03-16T00:00:00Z",
          },
        ],
        [
          "reviewer",
          {
            id: "reviewer-session",
            taskTargetId: sampleTarget.id,
            role: "reviewer",
            runnerName: "opencode",
            runnerModel: config.runner.reviewer.model,
            runnerVariant: "high",
            nativeSessionId: "reviewer-native-session",
            isActive: true,
            lastAttemptId: "attempt-reviewer",
            lastWorktreeHeadSha: "reviewer-head",
            lastReviewHeadSha: "abc123",
            createdAt: "2026-03-16T00:00:00Z",
            updatedAt: "2026-03-16T00:00:00Z",
          },
        ],
      ]);
      const getActiveSession = vi.fn((selector: { role: string; runnerName: string; runnerModel: string; runnerVariant: string }) => {
        const session = activeSessions.get(selector.role);
        return session?.isActive &&
          session.runnerName === selector.runnerName &&
          session.runnerModel === selector.runnerModel &&
          session.runnerVariant === selector.runnerVariant
          ? session
          : null;
      });
      const createSession = vi.fn((input: { role: string; runnerName: string; runnerModel: string; runnerVariant: string; isActive: boolean }) => {
        const session = {
          id: `${input.role}-new-session-${createSession.mock.calls.length + 1}`,
          taskTargetId: sampleTarget.id,
          role: input.role,
          runnerName: input.runnerName,
          runnerModel: input.runnerModel,
          runnerVariant: input.runnerVariant,
          nativeSessionId: null,
          isActive: input.isActive,
          lastAttemptId: null,
          lastWorktreeHeadSha: null,
          lastReviewHeadSha: null,
          createdAt: "2026-03-16T00:00:00Z",
          updatedAt: "2026-03-16T00:00:00Z",
        };
        activeSessions.set(input.role, session);
        return session;
      });
      const updateSession = vi.fn((sessionId: string, patch: Record<string, unknown>) => {
        for (const [role, session] of activeSessions) {
          if (session.id === sessionId) {
            activeSessions.set(role, { ...session, ...patch });
            return;
          }
        }
      });
      const logger = {
        ...fakeLogger,
        flush: async () => {
          await fs.mkdir(paths.attemptsLogDir, { recursive: true });
          await fs.writeFile(path.join(paths.attemptsLogDir, "attempt-session.log"), "runner log\n");
        },
      };
      const scheduler = new SchedulerService({
        config,
        paths,
        foremanRepos: createMockRepos({
          attempts: {
            createAttemptWithLeases: vi.fn(() => ({
              id: "attempt-session",
              attemptNumber: 1,
              startedAt: "2026-03-16T00:00:00Z",
            })),
          },
          runnerSessions: {
            getActiveSession,
            createSession,
            updateSession,
          },
        }),
        taskSystem: {
          getTask: vi.fn(async () => sampleTask({ pullRequests: [{ repoKey: "repo-a", url: reviewContext.pullRequestUrl, source: "provider" }] })),
          transition: vi.fn(async () => undefined),
          upsertPullRequest: vi.fn(async () => undefined),
          addComment: vi.fn(async () => undefined),
        } as any,
        reviewService: {
          resolvePullRequest: vi.fn(resolvePullRequestFromTask),
          getContext: vi.fn(async () => reviewContext),
        } as any,
        repos: [{ key: "repo-a", rootPath: worktreePath, defaultBranch: "main" }],
        env: {
          FOREMAN_TEST_PROMPT_OUT: promptOut,
          FOREMAN_TEST_ARGV_OUT: argvOut,
        },
        logger: logger as any,
      });
      const worker = {
        id: "worker-1",
        slot: 1,
        status: "leased",
        currentAttemptId: null,
        lastHeartbeatAt: "2026-03-16T00:00:00Z",
      };

      await (scheduler as any).runJob(worker, {
        id: "job-review",
        taskId: "TASK-0001",
        taskTargetId: sampleTarget.id,
        action: "review",
        repoKey: "repo-a",
        baseBranch: "main",
        selectionContext: { reviewContext },
      });

      expect(JSON.parse(await fs.readFile(argvOut, "utf8"))).toContain("implementation-native-session");
      expect(await fs.readFile(promptOut, "utf8")).toContain("Continue addressing current PR feedback");

      await (scheduler as any).runJob(worker, {
        id: "job-reviewer",
        taskId: "TASK-0001",
        taskTargetId: sampleTarget.id,
        action: "reviewer",
        repoKey: "repo-a",
        baseBranch: "main",
        selectionContext: { reviewContext },
      });

      expect(JSON.parse(await fs.readFile(argvOut, "utf8"))).toContain("reviewer-native-session");
      expect(await fs.readFile(promptOut, "utf8")).toContain("Review the latest PR changes.");

      getActiveSession.mockClear();
      await (scheduler as any).runJob(worker, {
        id: "job-retry",
        taskId: "TASK-0001",
        taskTargetId: sampleTarget.id,
        action: "retry",
        repoKey: "repo-a",
        baseBranch: "main",
      });

      expect(getActiveSession.mock.calls.map(([selector]) => selector.role)).toEqual(["reviewer"]);
      expect(JSON.parse(await fs.readFile(argvOut, "utf8"))).not.toContain("implementation-native-session");
      expect(await fs.readFile(promptOut, "utf8")).toContain("# Retry Prompt");
      expect(updateSession).toHaveBeenCalledWith("reviewer-session", { isActive: false });

      await (scheduler as any).runJob(worker, {
        id: "job-reviewer-after-retry",
        taskId: "TASK-0001",
        taskTargetId: sampleTarget.id,
        action: "reviewer",
        repoKey: "repo-a",
        baseBranch: "main",
        selectionContext: { reviewContext },
      });

      expect(JSON.parse(await fs.readFile(argvOut, "utf8"))).not.toContain("reviewer-native-session");
      expect(await fs.readFile(promptOut, "utf8")).toContain("# Reviewer Prompt");
    } finally {
      ensureTaskWorktree.mockRestore();
      if (originalOpencodeBin === undefined) {
        delete process.env.FOREMAN_OPENCODE_BIN;
      } else {
        process.env.FOREMAN_OPENCODE_BIN = originalOpencodeBin;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports non-zero runner output instead of schema parse noise", async () => {
    const tempDir = await createTempDir("foreman-runner-failure-test-");
    const paths = createWorkspacePaths(testProjectRoot, tempDir);
    const worktreePath = path.join(tempDir, "worktree");
    const fakeRunnerPath = path.join(tempDir, "fake-opencode.js");
    const originalOpencodeBin = process.env.FOREMAN_OPENCODE_BIN;
    const ensureTaskWorktree = vi.spyOn(worktrees, "ensureTaskWorktree").mockResolvedValue(worktreePath);

    try {
      await fs.mkdir(worktreePath, { recursive: true });
      await fs.writeFile(
        fakeRunnerPath,
        [
          "#!/usr/bin/env node",
          "process.stdin.resume();",
          "process.stdin.on('end', () => {",
          "  process.stdout.write('There is an issue with the selected model. Run --model to pick a different model.');",
          "  process.exit(1);",
          "});",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.FOREMAN_OPENCODE_BIN = fakeRunnerPath;

      const addAttemptEvent = vi.fn();
      const finalizeAttempt = vi.fn();
      const updateJobStatus = vi.fn();
      const releaseLeasesForAttempt = vi.fn();
      const updateWorkerStatus = vi.fn();
      const transition = vi.fn(async () => undefined);
      const logger = {
        ...fakeLogger,
        flush: async () => {
          await fs.mkdir(paths.attemptsLogDir, { recursive: true });
          await fs.writeFile(path.join(paths.attemptsLogDir, "attempt-runner-failure.log"), "runner log\n");
        },
      };
      const scheduler = new SchedulerService({
        config: createDefaultWorkspaceConfig("foo", "file"),
        paths,
        foremanRepos: createMockRepos({
          attempts: {
            createAttemptWithLeases: vi.fn(() => ({
              id: "attempt-runner-failure",
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
          listComments: vi.fn(async () => []),
        } as any,
        reviewService: {} as any,
        repos: [{ key: "repo-a", rootPath: worktreePath, defaultBranch: "main" }],
        env: {},
        logger: logger as any,
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
          taskTargetId: "target-1",
          action: "execution",
          repoKey: "repo-a",
          baseBranch: "main",
        },
      );

      expect(addAttemptEvent).toHaveBeenCalledWith(
        "attempt-runner-failure",
        "attempt_failed",
        expect.stringContaining("Runner exited with exit code 1"),
      );
      expect(transition).toHaveBeenNthCalledWith(1, { taskId: "TASK-0001", toState: "in_progress" });
      expect(transition).toHaveBeenNthCalledWith(2, { taskId: "TASK-0001", toState: "ready" });
      expect(addAttemptEvent).toHaveBeenCalledWith(
        "attempt-runner-failure",
        "attempt_failed",
        expect.stringContaining("selected model"),
      );
      expect(addAttemptEvent).not.toHaveBeenCalledWith(
        "attempt-runner-failure",
        "attempt_failed",
        expect.stringContaining("<agent-result>"),
      );
      expect(finalizeAttempt).toHaveBeenCalledWith(
        "attempt-runner-failure",
        "failed",
        expect.objectContaining({
          summary: expect.stringContaining("Runner exited with exit code 1"),
          errorMessage: expect.stringContaining("selected model"),
        }),
      );
      expect(updateJobStatus).toHaveBeenLastCalledWith(
        "job-1",
        "failed",
        expect.objectContaining({ errorMessage: expect.stringContaining("selected model") }),
      );
      expect(releaseLeasesForAttempt).toHaveBeenCalledWith("attempt-runner-failure", "completed");
      expect(updateWorkerStatus).toHaveBeenLastCalledWith("worker-1", "idle", null);
    } finally {
      ensureTaskWorktree.mockRestore();
      if (originalOpencodeBin === undefined) {
        delete process.env.FOREMAN_OPENCODE_BIN;
      } else {
        process.env.FOREMAN_OPENCODE_BIN = originalOpencodeBin;
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
