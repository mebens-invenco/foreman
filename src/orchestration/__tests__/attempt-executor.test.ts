import { Writable } from "node:stream";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ActionType, RepoRef, Task, WorkerResult } from "../../domain/index.js";
import { priorityToRank } from "../../domain/index.js";
import { ProviderRateLimitError } from "../../lib/errors.js";
import { exec } from "../../lib/process.js";
import { LoggerService } from "../../logger.js";
import type { ReviewService } from "../../review/index.js";
import type { TaskSystem } from "../../tasking/index.js";
import { createMigratedDb, createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { AttemptExecutor } from "../attempt-executor.js";

const runnerMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const worktreeMocks = vi.hoisted(() => ({
  worktreePath: "",
  ensureTaskWorktree: vi.fn(),
}));

vi.mock("../../execution/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../execution/index.js")>("../../execution/index.js");
  return {
    ...actual,
    createAgentRunner: vi.fn(() => ({ invoke: runnerMocks.invoke })),
  };
});

vi.mock("../../workspace/git-worktrees.js", async () => {
  const actual = await vi.importActual<typeof import("../../workspace/git-worktrees.js")>("../../workspace/git-worktrees.js");
  return {
    ...actual,
    ensureTaskWorktree: worktreeMocks.ensureTaskWorktree,
  };
});

const cleanupDirs: string[] = [];

const nullWritable = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const task: Task = {
  id: "ENG-5047",
  provider: "file",
  providerId: "ENG-5047",
  title: "Recover missing worker result blocks",
  description: "",
  state: "ready",
  providerState: "ready",
  priority: "normal",
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: "foreman", branchName: "eng-5047", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-05-06T00:00:00.000Z",
  url: null,
};

const createGitRepo = async (root: string): Promise<void> => {
  await fs.mkdir(root, { recursive: true });
  await exec("git", ["init", "-b", "master"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "# Test repo\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["-c", "user.name=Foreman Test", "-c", "user.email=foreman@example.test", "commit", "-m", "initial"], {
    cwd: root,
  });
};

const createWorkerResult = (overrides: Partial<WorkerResult> = {}): WorkerResult => ({
  schemaVersion: 1,
  action: "execution",
  outcome: "completed",
  summary: "Recovered structured result.",
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [],
  blockers: [],
  signals: [],
  ...overrides,
});

const createExecutorContext = async (options: { action?: ActionType; selectedTask?: Task; selectionContext?: Record<string, unknown> } = {}) => {
  const selectedTask = options.selectedTask ?? task;
  const action = options.action ?? "execution";
  const workspaceRoot = await createTempDir("foreman-attempt-executor-test-");
  cleanupDirs.push(workspaceRoot);
  const repoRoot = path.join(workspaceRoot, "repo");
  await createGitRepo(repoRoot);
  worktreeMocks.worktreePath = repoRoot;
  worktreeMocks.ensureTaskWorktree.mockResolvedValue(repoRoot);

  const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
  db.workers.ensureWorkerSlots(1);
  db.taskMirror.saveTasks([selectedTask]);
  const target = db.taskMirror.getTaskTarget(selectedTask.id, "foreman")!;
  const job = db.jobs.createJob({
    taskId: selectedTask.id,
    taskTargetId: target.id,
    taskProvider: "file",
    action,
    priorityRank: priorityToRank(selectedTask.priority),
    repoKey: "foreman",
    baseBranch: "master",
    dedupeKey: `${selectedTask.id}:${action}`,
    selectionReason: "test",
    ...(options.selectionContext ? { selectionContext: options.selectionContext } : {}),
  });
  db.jobs.claimQueuedJobForWorker(job.id, db.workers.listWorkers()[0]!.id);
  const claimedJob = db.jobs.getJob(job.id);
  const taskSystem: TaskSystem = {
    getProvider: () => "file",
    listCandidates: vi.fn(async () => []),
    getTask: vi.fn(async () => selectedTask),
    createTask: vi.fn(async () => ({ id: "TASK-NEW", providerId: "TASK-NEW", url: null })),
    listComments: vi.fn(async () => []),
    addComment: vi.fn(async () => undefined),
    transition: vi.fn(async () => undefined),
    upsertPullRequest: vi.fn(async () => undefined),
    updateLabels: vi.fn(async () => undefined),
  };
  const reviewService = {
    resolvePullRequest: vi.fn(async () => null),
  } as unknown as ReviewService;
  const repo: RepoRef = { key: "foreman", rootPath: repoRoot, defaultBranch: "master" };
  const logger = LoggerService.create({ paths, stdout: nullWritable, minLevel: "info" });
  const applyWorkerResult = vi.fn(async () => null);
  const config = createDefaultWorkspaceConfig("test-workspace", "file");
  const executor = new AttemptExecutor({
    config,
    paths,
    foremanRepos: db,
    taskSystem,
    reviewService,
    repos: [repo],
    env: {},
    logger,
    applyWorkerResult,
    onWorkerUpdated: vi.fn(),
    onAttemptChanged: vi.fn(),
    onWorkerFinished: vi.fn(),
  });

  return { workspaceRoot, db, job, claimedJob, executor, logger, applyWorkerResult, target, config };
};

afterEach(async () => {
  runnerMocks.invoke.mockReset();
  worktreeMocks.ensureTaskWorktree.mockReset();
  worktreeMocks.worktreePath = "";
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("AttemptExecutor", () => {
  test("recovers a valid worker result when a successful runner emits natural final text", async () => {
    const workspaceRoot = await createTempDir("foreman-attempt-executor-test-");
    cleanupDirs.push(workspaceRoot);
    const repoRoot = path.join(workspaceRoot, "repo");
    await createGitRepo(repoRoot);
    worktreeMocks.worktreePath = repoRoot;
    worktreeMocks.ensureTaskWorktree.mockResolvedValue(repoRoot);

    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      db.taskMirror.saveTasks([task]);
      const target = db.taskMirror.getTaskTarget(task.id, "foreman")!;
      const job = db.jobs.createJob({
        taskId: task.id,
        taskTargetId: target.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank(task.priority),
        repoKey: "foreman",
        baseBranch: "master",
        dedupeKey: `${task.id}:execution`,
        selectionReason: "test",
      });
      db.jobs.claimQueuedJobForWorker(job.id, db.workers.listWorkers()[0]!.id);
      const claimedJob = db.jobs.getJob(job.id);
      const recoveredResult: WorkerResult = {
        schemaVersion: 1,
        action: "execution",
        outcome: "completed",
        summary: "Recovered structured result.",
        taskMutations: [],
        reviewMutations: [],
        learningMutations: [],
        blockers: [],
        signals: [],
      };
      runnerMocks.invoke
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          startedAt: "2026-05-06T00:00:00.000Z",
          finishedAt: "2026-05-06T00:01:00.000Z",
          stdoutBytes: Buffer.byteLength("Implemented the change and pushed the branch."),
          stderrBytes: 0,
          stdout: "Implemented the change and pushed the branch.",
          stderr: "",
          nativeSessionId: "native-session-1",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          startedAt: "2026-05-06T00:01:00.000Z",
          finishedAt: "2026-05-06T00:02:00.000Z",
          stdoutBytes: Buffer.byteLength(JSON.stringify(recoveredResult)),
          stderrBytes: 0,
          stdout: `<agent-result>\n${JSON.stringify(recoveredResult)}\n</agent-result>`,
          stderr: "",
          nativeSessionId: "native-session-1",
        });
      const taskSystem: TaskSystem = {
        getProvider: () => "file",
        listCandidates: vi.fn(async () => []),
        getTask: vi.fn(async () => task),
        createTask: vi.fn(async () => ({ id: "TASK-NEW", providerId: "TASK-NEW", url: null })),
        listComments: vi.fn(async () => []),
        addComment: vi.fn(async () => undefined),
        transition: vi.fn(async () => undefined),
        upsertPullRequest: vi.fn(async () => undefined),
        updateLabels: vi.fn(async () => undefined),
      };
      const reviewService = {
        resolvePullRequest: vi.fn(async () => null),
      } as unknown as ReviewService;
      const repo: RepoRef = { key: "foreman", rootPath: repoRoot, defaultBranch: "master" };
      const logger = LoggerService.create({ paths, stdout: nullWritable, minLevel: "info" });
      const executor = new AttemptExecutor({
        config: createDefaultWorkspaceConfig("test-workspace", "file"),
        paths,
        foremanRepos: db,
        taskSystem,
        reviewService,
        repos: [repo],
        env: {},
        logger,
        applyWorkerResult: vi.fn(async () => null),
        onWorkerUpdated: vi.fn(),
        onAttemptChanged: vi.fn(),
        onWorkerFinished: vi.fn(),
      });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      expect(runnerMocks.invoke).toHaveBeenCalledTimes(2);
      expect(runnerMocks.invoke.mock.calls[1]![0]).toMatchObject({
        nativeSessionId: "native-session-1",
      });
      expect(runnerMocks.invoke.mock.calls[1]![0].prompt).toContain("could not parse a valid `<agent-result>` block");

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.status).toBe("completed");
      expect(attempt.summary).toBe("Recovered structured result.");
      const artifacts = db.artifacts.listArtifacts("execution_attempt", attempt.id);
      expect(artifacts.filter((artifact) => artifact.artifactType === "runner_output")).toHaveLength(2);
      const originalOutputArtifact = artifacts.find((artifact) => artifact.relativePath.endsWith("runner-output.txt"))!;
      await expect(fs.readFile(path.join(workspaceRoot, originalOutputArtifact.relativePath), "utf8")).resolves.toBe(
        "Implemented the change and pushed the branch.",
      );
      expect(db.attempts.listAttemptEvents(attempt.id).map((event) => event.eventType)).toContain("worker_result_recovered");
    } finally {
      db.close();
    }
  });

  test("persists token usage on the attempt when the primary runner completes successfully", async () => {
    const { db, job, claimedJob, executor, logger } = await createExecutorContext();

    try {
      const workerResult = createWorkerResult({ summary: "Done." });
      runnerMocks.invoke.mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T00:01:00.000Z",
        stdoutBytes: Buffer.byteLength(JSON.stringify(workerResult)),
        stderrBytes: 0,
        stdout: `<agent-result>\n${JSON.stringify(workerResult)}\n</agent-result>`,
        stderr: "",
        tokensUsed: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50 },
      });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.tokensUsed).toEqual({ inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50 });
    } finally {
      db.close();
    }
  });

  test("accumulates primary plus recovery token usage when recovery succeeds", async () => {
    const { db, job, claimedJob, executor, logger } = await createExecutorContext();

    try {
      const recoveredResult = createWorkerResult({ summary: "Recovered." });
      runnerMocks.invoke
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          startedAt: "2026-05-06T00:00:00.000Z",
          finishedAt: "2026-05-06T00:01:00.000Z",
          stdoutBytes: Buffer.byteLength("Implemented the change."),
          stderrBytes: 0,
          stdout: "Implemented the change.",
          stderr: "",
          tokensUsed: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50 },
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          startedAt: "2026-05-06T00:01:00.000Z",
          finishedAt: "2026-05-06T00:02:00.000Z",
          stdoutBytes: Buffer.byteLength(JSON.stringify(recoveredResult)),
          stderrBytes: 0,
          stdout: `<agent-result>\n${JSON.stringify(recoveredResult)}\n</agent-result>`,
          stderr: "",
          tokensUsed: { inputTokens: 100, outputTokens: 25, cacheReadInputTokens: 10 },
        });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.tokensUsed).toEqual({ inputTokens: 1100, outputTokens: 225, cacheReadInputTokens: 60 });
    } finally {
      db.close();
    }
  });

  test("leaves token usage null when the runner fails before producing tokens", async () => {
    const { db, job, claimedJob, executor, logger } = await createExecutorContext();

    try {
      runnerMocks.invoke.mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T00:01:00.000Z",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdout: "",
        stderr: "boom",
      });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.status).toBe("failed");
      expect(attempt.tokensUsed).toBeNull();
    } finally {
      db.close();
    }
  });

  test("recovers a worker result from stdout after a non-aborted runner timeout", async () => {
    const { db, job, claimedJob, executor, logger, applyWorkerResult } = await createExecutorContext();

    try {
      const recoveredResult = createWorkerResult({ summary: "Recovered timeout checkpoint." });
      runnerMocks.invoke
        .mockResolvedValueOnce({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          timeoutMs: 3_600_000,
          startedAt: "2026-05-06T00:00:00.000Z",
          finishedAt: "2026-05-06T01:00:00.000Z",
          stdoutBytes: Buffer.byteLength("Progress summary that can be recovered."),
          stderrBytes: 0,
          stdout: "Progress summary that can be recovered.",
          stderr: "",
          nativeSessionId: "native-session-timeout",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          timeoutMs: null,
          startedAt: "2026-05-06T01:00:00.000Z",
          finishedAt: "2026-05-06T01:01:00.000Z",
          stdoutBytes: Buffer.byteLength(JSON.stringify(recoveredResult)),
          stderrBytes: 0,
          stdout: `<agent-result>\n${JSON.stringify(recoveredResult)}\n</agent-result>`,
          stderr: "",
          nativeSessionId: "native-session-timeout",
        });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      expect(runnerMocks.invoke).toHaveBeenCalledTimes(2);
      expect(runnerMocks.invoke.mock.calls[1]![0]).toMatchObject({
        nativeSessionId: "native-session-timeout",
        timeoutMs: 120_000,
      });
      expect(applyWorkerResult).toHaveBeenCalledWith(expect.objectContaining({ workerResult: recoveredResult }));

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.status).toBe("completed");
      expect(attempt.summary).toBe("Recovered timeout checkpoint.");
      expect(db.attempts.listAttemptEvents(attempt.id).map((event) => event.eventType)).toContain("worker_result_recovered");
    } finally {
      db.close();
    }
  });

  test("isolates deployment runner sessions and resumes blocked deployments", async () => {
    const deploymentSelectionContext = {
      deployment: { instructionHash: "deployment-instructions", instructionBody: "Check production once." },
      pullRequestReference: {
        provider: "github",
        url: "https://github.com/acme/foreman/pull/10",
        number: 10,
        state: "merged",
        headBranch: "eng-5047",
        baseBranch: "master",
      },
    };
    const { db, claimedJob, executor, logger, target, config } = await createExecutorContext({
      action: "deployment",
      selectedTask: { ...task, state: "deployable", providerState: "deployable" },
      selectionContext: deploymentSelectionContext,
    });

    const runnerSelector = {
      taskTargetId: target.id,
      runnerName: config.runner.execution.type,
      runnerModel: config.runner.execution.model,
      runnerVariant: "high",
    };
    const implementationSession = db.runnerSessions.createSession({
      ...runnerSelector,
      role: "implementation",
      isActive: true,
      nativeSessionId: "implementation-native-session",
    });
    const createDeploymentResult = (outcome: "in_progress" | "blocked" | "succeeded", summary: string): WorkerResult =>
      createWorkerResult({
        action: "deployment",
        outcome,
        summary,
        blockers: outcome === "blocked" ? ["Deployment status page was unavailable."] : [],
      });
    const createRunResult = (workerResult: WorkerResult) => ({
      exitCode: 0,
      signal: null,
      startedAt: "2026-05-06T00:00:00.000Z",
      finishedAt: "2026-05-06T00:01:00.000Z",
      stdoutBytes: Buffer.byteLength(JSON.stringify(workerResult)),
      stderrBytes: 0,
      stdout: `<agent-result>\n${JSON.stringify(workerResult)}\n</agent-result>`,
      stderr: "",
      nativeSessionId: "deployment-native-session",
    });

    try {
      runnerMocks.invoke.mockResolvedValueOnce(createRunResult(createDeploymentResult("in_progress", "Deployment is still rolling out.")));

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      expect(runnerMocks.invoke).toHaveBeenCalledTimes(1);
      expect(runnerMocks.invoke.mock.calls[0]![0]).not.toHaveProperty("nativeSessionId");
      expect(db.runnerSessions.getActiveSession({ ...runnerSelector, role: "implementation" })?.id).toBe(implementationSession.id);
      expect(db.runnerSessions.getActiveSession({ ...runnerSelector, role: "deployment" })).toMatchObject({
        nativeSessionId: "deployment-native-session",
      });

      const blockedJob = db.jobs.createJob({
        taskId: task.id,
        taskTargetId: target.id,
        taskProvider: "file",
        action: "deployment",
        priorityRank: priorityToRank(task.priority),
        repoKey: "foreman",
        baseBranch: "master",
        dedupeKey: `${task.id}:deployment:blocked`,
        selectionReason: "test blocked deployment",
        selectionContext: deploymentSelectionContext,
      });
      db.jobs.claimQueuedJobForWorker(blockedJob.id, db.workers.listWorkers()[0]!.id);
      runnerMocks.invoke.mockResolvedValueOnce(createRunResult(createDeploymentResult("blocked", "Deployment could not be checked.")));

      await executor.execute(db.workers.listWorkers()[0]!, db.jobs.getJob(blockedJob.id)!, new AbortController());
      await logger.flush();

      expect(runnerMocks.invoke.mock.calls[1]![0]).toMatchObject({ nativeSessionId: "deployment-native-session" });
      expect(db.runnerSessions.getActiveSession({ ...runnerSelector, role: "deployment" })).toMatchObject({
        nativeSessionId: "deployment-native-session",
      });

      const retryAfterBlockedJob = db.jobs.createJob({
        taskId: task.id,
        taskTargetId: target.id,
        taskProvider: "file",
        action: "deployment",
        priorityRank: priorityToRank(task.priority),
        repoKey: "foreman",
        baseBranch: "master",
        dedupeKey: `${task.id}:deployment:after-blocked`,
        selectionReason: "test retry after blocked deployment",
        selectionContext: deploymentSelectionContext,
      });
      db.jobs.claimQueuedJobForWorker(retryAfterBlockedJob.id, db.workers.listWorkers()[0]!.id);
      runnerMocks.invoke.mockResolvedValueOnce(createRunResult(createDeploymentResult("succeeded", "Deployment verified.")));

      await executor.execute(db.workers.listWorkers()[0]!, db.jobs.getJob(retryAfterBlockedJob.id)!, new AbortController());
      await logger.flush();

      expect(runnerMocks.invoke.mock.calls[2]![0]).toMatchObject({ nativeSessionId: "deployment-native-session" });
      expect(runnerMocks.invoke).toHaveBeenCalledTimes(3);
    } finally {
      db.close();
    }
  });

  test("records a timeout-specific failure when timed-out stdout cannot be recovered", async () => {
    const { db, job, claimedJob, executor, logger } = await createExecutorContext();

    try {
      runnerMocks.invoke.mockResolvedValueOnce({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        timeoutMs: 3_600_000,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T01:00:00.000Z",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdout: "",
        stderr: "",
      });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      expect(runnerMocks.invoke).toHaveBeenCalledTimes(1);
      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.status).toBe("timed_out");
      expect(attempt.summary).toContain("Runner exited with timed out after 3600000ms with signal SIGTERM");
      expect(attempt.summary).toContain("No runner output was captured.");
    } finally {
      db.close();
    }
  });

  test("does not attempt timeout recovery when the scheduler abort signal is set", async () => {
    const { db, job, claimedJob, executor, logger } = await createExecutorContext();

    try {
      runnerMocks.invoke.mockResolvedValueOnce({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        timeoutMs: 3_600_000,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T01:00:00.000Z",
        stdoutBytes: Buffer.byteLength("Progress summary that should not be recovered."),
        stderrBytes: 0,
        stdout: "Progress summary that should not be recovered.",
        stderr: "",
      });
      const controller = new AbortController();
      controller.abort();

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, controller);
      await logger.flush();

      expect(runnerMocks.invoke).toHaveBeenCalledTimes(1);
      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.status).toBe("canceled");
      expect(attempt.summary).toContain("Runner exited with timed out after 3600000ms with signal SIGTERM");

    } finally {
      db.close();
    }
  });

  test("uses the task's execution override on the attempt record and runner session", async () => {
    const overrideTask: Task = {
      ...task,
      runnerOverride: { execution: { model: "openai/gpt-5.5-pro", variant: "max" } },
    };
    const { db, claimedJob, executor, logger, target } = await createExecutorContext({ selectedTask: overrideTask });

    try {
      const workerResult = createWorkerResult({ summary: "Used overridden model." });
      runnerMocks.invoke.mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T00:01:00.000Z",
        stdoutBytes: Buffer.byteLength(JSON.stringify(workerResult)),
        stderrBytes: 0,
        stdout: `<agent-result>\n${JSON.stringify(workerResult)}\n</agent-result>`,
        stderr: "",
        nativeSessionId: "native-session-override",
      });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      const attempt = db.attempts.latestAttemptForJob(claimedJob.id)!;
      expect(attempt.runnerModel).toBe("openai/gpt-5.5-pro");
      expect(attempt.runnerVariant).toBe("max");

      const session = db.runnerSessions.getActiveSession({
        taskTargetId: target.id,
        role: "implementation",
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.5-pro",
        runnerVariant: "max",
      });
      expect(session?.nativeSessionId).toBe("native-session-override");

      // The workspace-default session selector should remain empty so an
      // overridden-model attempt cannot reuse a default-model session.
      expect(
        db.runnerSessions.getActiveSession({
          taskTargetId: target.id,
          role: "implementation",
          runnerName: "opencode",
          runnerModel: "openai/gpt-5.5",
          runnerVariant: "high",
        }),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  test("rejects an attempt whose override is invalid for the active provider", async () => {
    const overrideTask: Task = {
      ...task,
      runnerOverride: { execution: { effort: "ultra" } },
    };
    const { db, claimedJob, executor, logger, config } = await createExecutorContext({ selectedTask: overrideTask });
    config.runner.execution = { type: "codex", model: "gpt-5.5", effort: "high", timeoutMs: 3_600_000 };

    try {
      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      expect(runnerMocks.invoke).not.toHaveBeenCalled();
      expect(db.jobs.getJob(claimedJob.id)).toMatchObject({ status: "failed" });
    } finally {
      db.close();
    }
  });

  test("does not fail a completed retry when the reviewer override is invalid for the workspace reviewer provider", async () => {
    const overrideTask: Task = {
      ...task,
      runnerOverride: { reviewer: { effort: "ultra" } },
    };
    const { db, claimedJob, executor, logger } = await createExecutorContext({
      action: "retry",
      selectedTask: overrideTask,
    });

    try {
      const workerResult = createWorkerResult({ action: "retry", summary: "Retry succeeded." });
      runnerMocks.invoke.mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T00:01:00.000Z",
        stdoutBytes: Buffer.byteLength(JSON.stringify(workerResult)),
        stderrBytes: 0,
        stdout: `<agent-result>\n${JSON.stringify(workerResult)}\n</agent-result>`,
        stderr: "",
      });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      const attempt = db.attempts.latestAttemptForJob(claimedJob.id)!;
      expect(attempt.status).toBe("completed");
      expect(db.jobs.getJob(claimedJob.id)).toMatchObject({ status: "completed" });
    } finally {
      db.close();
    }
  });

  test("marks attempts blocked when provider rate limiting interrupts result application", async () => {
    const { db, job, claimedJob, executor, logger, applyWorkerResult } = await createExecutorContext();

    try {
      const workerResult = createWorkerResult({ summary: "Implemented change." });
      runnerMocks.invoke.mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        startedAt: "2026-05-06T00:00:00.000Z",
        finishedAt: "2026-05-06T00:01:00.000Z",
        stdoutBytes: Buffer.byteLength(JSON.stringify(workerResult)),
        stderrBytes: 0,
        stdout: `<agent-result>\n${JSON.stringify(workerResult)}\n</agent-result>`,
        stderr: "",
      });
      applyWorkerResult.mockImplementation(async () => {
        throw new ProviderRateLimitError({
          provider: "github",
          retryAfterSeconds: 120,
          resetAt: "2026-05-06T00:03:00.000Z",
        });
      });

      await executor.execute(db.workers.listWorkers()[0]!, claimedJob, new AbortController());
      await logger.flush();

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.status).toBe("blocked");
      expect(attempt.errorMessage).toBeNull();
      expect(db.jobs.getJob(job.id)).toMatchObject({ status: "blocked", errorMessage: null });
      expect(db.attempts.listAttemptEvents(attempt.id).map((event) => event.eventType)).toContain("attempt_blocked");
    } finally {
      db.close();
    }
  });
});
