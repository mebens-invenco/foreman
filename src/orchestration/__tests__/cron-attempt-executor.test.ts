import { Writable } from "node:stream";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LoggerService } from "../../logger.js";
import { createMigratedDb, createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { CronAttemptExecutor } from "../cron-attempt-executor.js";

const runnerMocks = vi.hoisted(() => {
  const invoke = vi.fn();
  return {
    invoke,
    createAgentRunner: vi.fn(() => ({ invoke })),
  };
});

vi.mock("../../execution/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../execution/index.js")>("../../execution/index.js");
  return {
    ...actual,
    createAgentRunner: runnerMocks.createAgentRunner,
  };
});

const cleanupDirs: string[] = [];

beforeEach(() => {
  runnerMocks.createAgentRunner.mockClear();
  runnerMocks.invoke.mockReset();
  runnerMocks.invoke.mockImplementation(async (request: { onStdoutLine?: (line: string) => void }) => {
    request.onStdoutLine?.("Cron found nothing.");
    return {
      exitCode: 0,
      signal: null,
      startedAt: "2026-03-14T12:00:00.000Z",
      finishedAt: "2026-03-14T12:01:00.000Z",
      stdoutBytes: Buffer.byteLength("Cron found nothing."),
      stderrBytes: 0,
      stdout: "Cron found nothing.",
      stderr: "",
    };
  });
});

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const nullWritable = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const createCronExecutorContext = async () => {
  const workspaceRoot = await createTempDir("foreman-cron-attempt-test-");
  cleanupDirs.push(workspaceRoot);
  const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
  await fs.mkdir(path.join(workspaceRoot, "cron"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "cron", "check.md"), "---\ninterval: 15m\n---\nCheck the workspace.");
  const config = createDefaultWorkspaceConfig("foo", "file");
  config.cron.enabled = true;
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0]!;
  const job = db.jobs.createCronJob({
    cronJobId: "cron/check.md",
    dedupeKey: "cron:cron/check.md",
    selectionReason: "test",
  });
  db.jobs.claimQueuedJobForWorker(job.id, worker.id);
  const executor = new CronAttemptExecutor({
    config,
    paths,
    foremanRepos: db,
    repos: [],
    env: {},
    logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
    onWorkerUpdated: vi.fn(),
    onAttemptChanged: vi.fn(),
    onWorkerFinished: vi.fn(),
  });

  return { config, db, worker, job, executor };
};

const interruptedCronRunResult = () => ({
  exitCode: 1,
  signal: null,
  startedAt: "2026-03-14T12:00:00.000Z",
  finishedAt: "2026-03-14T12:01:00.000Z",
  stdoutBytes: 128,
  stderrBytes: 0,
  stdout: '{"type":"error"}',
  stderr: "",
  nativeSessionId: "cron-native-session",
  retryableInterruption: { summary: "OpenCode APIError returned retryable HTTP 503." },
});

describe("CronAttemptExecutor", () => {
  test("requeues an interrupted cron job before its interval and resumes its native session", async () => {
    const { db, worker, job, executor } = await createCronExecutorContext();
    runnerMocks.invoke
      .mockImplementationOnce(async (request: { onStdoutLine?: (line: string) => void }) => {
        request.onStdoutLine?.('{"type":"error"}');
        return interruptedCronRunResult();
      })
      .mockImplementationOnce(async (request: { onStdoutLine?: (line: string) => void }) => {
        request.onStdoutLine?.("Cron recovered.");
        return {
          exitCode: 0,
          signal: null,
          startedAt: "2026-03-14T12:01:30.000Z",
          finishedAt: "2026-03-14T12:02:00.000Z",
          stdoutBytes: Buffer.byteLength("Cron recovered."),
          stderrBytes: 0,
          stdout: "Cron recovered.",
          stderr: "",
          nativeSessionId: "cron-native-session",
        };
      });

    try {
      await executor.execute(worker, db.jobs.getJob(job.id), new AbortController());

      expect(db.jobs.getJob(job.id)).toMatchObject({
        status: "queued",
        nextEligibleAt: "2026-03-14T12:01:30.000Z",
        finishedAt: null,
      });
      expect(db.jobs.hasActiveDedupeKey(job.dedupeKey)).toBe(true);
      expect(db.attempts.latestAttemptForJob(job.id)).toMatchObject({ status: "failed", attemptNumber: 1 });

      expect(db.jobs.claimQueuedJobForWorker(job.id, worker.id)).toBe(true);
      await executor.execute(worker, db.jobs.getJob(job.id), new AbortController());

      expect(runnerMocks.invoke.mock.calls[1]![0]).toMatchObject({ nativeSessionId: "cron-native-session" });
      expect(db.attempts.listAttempts({ jobId: job.id }).map((attempt) => attempt.attemptNumber).sort()).toEqual([1, 2]);
      expect(db.jobs.getJob(job.id)).toMatchObject({ status: "completed", errorMessage: null });
    } finally {
      db.close();
    }
  });

  test("starts a fresh session when the configured runner changes during backoff", async () => {
    const { config, db, worker, job, executor } = await createCronExecutorContext();
    runnerMocks.invoke.mockReset();
    runnerMocks.invoke.mockImplementation(async (request: { onStdoutLine?: (line: string) => void }) => {
      request.onStdoutLine?.('{"type":"error"}');
      return interruptedCronRunResult();
    });

    try {
      await executor.execute(worker, db.jobs.getJob(job.id), new AbortController());
      expect(db.jobs.getJob(job.id).status).toBe("queued");
      expect(db.jobs.getJob(job.id).selectionContext).toMatchObject({
        runnerInterruption: { runnerName: "opencode", nativeSessionId: "cron-native-session" },
      });

      runnerMocks.invoke.mockReset();
      runnerMocks.invoke.mockImplementation(async (request: { onStdoutLine?: (line: string) => void }) => {
        request.onStdoutLine?.("Cron recovered.");
        return {
          exitCode: 0,
          signal: null,
          startedAt: "2026-03-14T12:01:30.000Z",
          finishedAt: "2026-03-14T12:02:00.000Z",
          stdoutBytes: 15,
          stderrBytes: 0,
          stdout: "Cron recovered.",
          stderr: "",
          nativeSessionId: "019b5bf0-0eb8-7a21-9c61-e4dffc778307",
        };
      });
      config.runner.execution = { type: "codex", model: "gpt-5.5", effort: "high", timeoutMs: 3_600_000 };
      expect(db.jobs.claimQueuedJobForWorker(job.id, worker.id)).toBe(true);
      await executor.execute(worker, db.jobs.getJob(job.id), new AbortController());

      expect(runnerMocks.invoke.mock.calls[0]![0]).not.toHaveProperty("nativeSessionId");
      expect(db.jobs.getJob(job.id)).toMatchObject({ status: "completed" });
    } finally {
      db.close();
    }
  });

  test("cancels instead of requeueing when a stop is accepted as an interrupted run returns", async () => {
    const { db, worker, job, executor } = await createCronExecutorContext();
    const controller = new AbortController();
    runnerMocks.invoke.mockImplementationOnce(async (request: { onStdoutLine?: (line: string) => void }) => {
      request.onStdoutLine?.('{"type":"error"}');
      controller.abort();
      return interruptedCronRunResult();
    });

    try {
      await executor.execute(worker, db.jobs.getJob(job.id), controller);

      expect(db.attempts.latestAttemptForJob(job.id)).toMatchObject({ status: "canceled" });
      expect(db.jobs.getJob(job.id)).toMatchObject({ status: "canceled", nextEligibleAt: null });
      expect(db.jobs.hasActiveDedupeKey(job.dedupeKey)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("fails a cron job after three retryable runner interruptions", async () => {
    const { db, worker, job, executor } = await createCronExecutorContext();
    runnerMocks.invoke.mockImplementation(async (request: { onStdoutLine?: (line: string) => void }) => {
      request.onStdoutLine?.('{"type":"error"}');
      return interruptedCronRunResult();
    });

    try {
      await executor.execute(worker, db.jobs.getJob(job.id), new AbortController());
      expect(db.jobs.claimQueuedJobForWorker(job.id, worker.id)).toBe(true);
      await executor.execute(worker, db.jobs.getJob(job.id), new AbortController());
      expect(db.jobs.claimQueuedJobForWorker(job.id, worker.id)).toBe(true);
      await executor.execute(worker, db.jobs.getJob(job.id), new AbortController());

      expect(db.attempts.listAttempts({ jobId: job.id }).map((attempt) => attempt.attemptNumber).sort()).toEqual([1, 2, 3]);
      expect(db.jobs.getJob(job.id)).toMatchObject({
        status: "failed",
        errorMessage: "OpenCode APIError returned retryable HTTP 503. Automatic retry limit reached after 3 attempts.",
      });
      expect(db.jobs.hasActiveDedupeKey(job.dedupeKey)).toBe(false);
      expect(runnerMocks.invoke).toHaveBeenCalledTimes(3);
    } finally {
      db.close();
    }
  });

  test("persists prompt, runner output, and log artifacts", async () => {
    const workspaceRoot = await createTempDir("foreman-cron-attempt-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "cron"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "plan.md"), "# Plan\n");
    await fs.writeFile(path.join(workspaceRoot, "cron", "check.md"), "---\ninterval: 15m\n---\nCheck the workspace.");
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.cron.enabled = true;
    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0]!;
      const job = db.jobs.createCronJob({
        cronJobId: "cron/check.md",
        dedupeKey: "cron:cron/check.md",
        selectionReason: "test",
      });
      db.jobs.claimQueuedJobForWorker(job.id, worker.id);
      const claimed = db.jobs.getJob(job.id);
      const executor = new CronAttemptExecutor({
        config,
        paths,
        foremanRepos: db,
        repos: [],
        env: {},
        logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
        onWorkerUpdated: vi.fn(),
        onAttemptChanged: vi.fn(),
        onWorkerFinished: vi.fn(),
      });

      await executor.execute(worker, claimed, new AbortController());

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      expect(attempt.status).toBe("completed");
      const artifacts = db.artifacts.listArtifacts("execution_attempt", attempt.id);
      expect(artifacts.map((artifact) => artifact.artifactType).sort()).toEqual(["log", "rendered_prompt", "runner_output"]);
      const outputArtifact = artifacts.find((artifact) => artifact.artifactType === "runner_output")!;
      await expect(fs.readFile(path.join(workspaceRoot, outputArtifact.relativePath), "utf8")).resolves.toBe("Cron found nothing.");
    } finally {
      db.close();
    }
  });

  test("delays redispatch when cron execution leases cannot be acquired", async () => {
    const workspaceRoot = await createTempDir("foreman-cron-attempt-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "cron"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "cron", "check.md"), "---\ninterval: 15m\n---\nCheck the workspace.");
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.cron.enabled = true;
    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);

    try {
      db.workers.ensureWorkerSlots(2);
      const [worker, leaseHolder] = db.workers.listWorkers();
      expect(worker).toBeDefined();
      expect(leaseHolder).toBeDefined();
      const dedupeKey = "cron:cron/check.md";
      expect(
        db.leases.acquireLease({
          resourceType: "cron",
          resourceKey: dedupeKey,
          workerId: leaseHolder!.id,
          expiresAt: "2999-01-01T00:00:00.000Z",
        }),
      ).toBe(true);
      const job = db.jobs.createCronJob({
        cronJobId: "cron/check.md",
        dedupeKey,
        selectionReason: "test",
      });
      db.jobs.claimQueuedJobForWorker(job.id, worker!.id);
      const claimed = db.jobs.getJob(job.id);
      const executor = new CronAttemptExecutor({
        config,
        paths,
        foremanRepos: db,
        repos: [],
        env: {},
        logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
        onWorkerUpdated: vi.fn(),
        onAttemptChanged: vi.fn(),
        onWorkerFinished: vi.fn(),
      });

      const before = Date.now();
      await executor.execute(worker!, claimed, new AbortController());

      const returnedJob = db.jobs.getJob(job.id);
      expect(db.attempts.latestAttemptForJob(job.id)).toBeNull();
      expect(returnedJob.status).toBe("queued");
      expect(returnedJob.nextEligibleAt).toEqual(expect.any(String));
      expect(Date.parse(returnedJob.nextEligibleAt!)).toBeGreaterThanOrEqual(before + 14_000);
    } finally {
      db.close();
    }
  });

  test("finalizes timed-out cron runner results and releases the cron dedupe key", async () => {
    const workspaceRoot = await createTempDir("foreman-cron-attempt-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "cron"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "cron", "check.md"), "---\ninterval: 15m\n---\nCheck the workspace.");
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.cron.enabled = true;
    config.runner.execution.timeoutMs = 200;
    runnerMocks.invoke.mockImplementationOnce(async (request: { onStderrLine?: (line: string) => void }) => {
      request.onStderrLine?.("runner timed out");
      return {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        timeoutMs: 200,
        startedAt: "2026-03-14T12:00:00.000Z",
        finishedAt: "2026-03-14T12:00:00.200Z",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdout: "",
        stderr: "",
      };
    });
    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0]!;
      const dedupeKey = "cron:cron/check.md";
      const job = db.jobs.createCronJob({
        cronJobId: "cron/check.md",
        dedupeKey,
        selectionReason: "test",
      });
      db.jobs.claimQueuedJobForWorker(job.id, worker.id);
      const claimed = db.jobs.getJob(job.id);
      const executor = new CronAttemptExecutor({
        config,
        paths,
        foremanRepos: db,
        repos: [],
        env: {},
        logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
        onWorkerUpdated: vi.fn(),
        onAttemptChanged: vi.fn(),
        onWorkerFinished: vi.fn(),
      });

      await executor.execute(worker, claimed, new AbortController());

      const attempt = db.attempts.latestAttemptForJob(job.id)!;
      const finishedJob = db.jobs.getJob(job.id);
      const finishedWorker = db.workers.listWorkers()[0]!;
      expect(attempt.status).toBe("timed_out");
      expect(finishedJob.status).toBe("failed");
      expect(finishedWorker.status).toBe("idle");
      expect(finishedWorker.currentAttemptId).toBeNull();
      expect(db.jobs.hasActiveDedupeKey(dedupeKey)).toBe(false);
    } finally {
      db.close();
    }
  });
});
