import { Writable } from "node:stream";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { RepoRef, Task, WorkerResult } from "../../domain/index.js";
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
  pullRequests: [],
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

  test("marks attempts blocked when provider rate limiting interrupts result application", async () => {
    const workspaceRoot = await createTempDir("foreman-attempt-executor-rate-limit-test-");
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
      const workerResult: WorkerResult = {
        schemaVersion: 1,
        action: "execution",
        outcome: "completed",
        summary: "Implemented change.",
        taskMutations: [],
        reviewMutations: [],
        learningMutations: [],
        blockers: [],
        signals: [],
      };
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
        applyWorkerResult: vi.fn(async () => {
          throw new ProviderRateLimitError({
            provider: "github",
            retryAfterSeconds: 120,
            resetAt: "2026-05-06T00:03:00.000Z",
          });
        }),
        onWorkerUpdated: vi.fn(),
        onAttemptChanged: vi.fn(),
        onWorkerFinished: vi.fn(),
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
