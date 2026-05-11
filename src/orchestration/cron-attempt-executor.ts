import { promises as fs } from "node:fs";
import path from "node:path";

import { discoverCronJobs, renderCronPrompt } from "../cron/index.js";
import type { AttemptStatus, RepoRef } from "../domain/index.js";
import { createAgentRunner } from "../execution/index.js";
import { ForemanError } from "../lib/errors.js";
import { atomicWriteFile, ensureDir, sha256File } from "../lib/fs.js";
import { addSeconds, isoNow } from "../lib/time.js";
import type { LoggerService } from "../logger.js";
import type { AttemptRecord, ForemanRepos, JobRecord, WorkerRecord } from "../repos/index.js";
import { runnerForAction, runnerTuningValue, type WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";
import { nextLeaseConflictEligibleAt } from "./lease-conflict.js";

type CronAttemptExecutorDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  foremanRepos: ForemanRepos;
  repos: RepoRef[];
  env: Record<string, string>;
  logger: LoggerService;
  onWorkerUpdated: (input: { workerId: string; status: string; attemptId?: string | null }) => void;
  onAttemptChanged: (input: { attemptId: string; status: string }) => void;
  onWorkerFinished: () => void;
};

const cronAttemptStatus = (input: { exitCode: number | null; signal: string | null; aborted: boolean }): AttemptStatus => {
  if (input.aborted) {
    return "canceled";
  }
  if (input.exitCode === 0 && !input.signal) {
    return "completed";
  }
  if (input.exitCode === null && !input.signal) {
    return "timed_out";
  }
  return "failed";
};

const summarizeOutput = (stdout: string, status: AttemptStatus): string => {
  const trimmed = stdout.trim();
  if (trimmed) {
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
  }
  return status === "completed" ? "Cron job completed without stdout." : "Cron job did not produce stdout.";
};

export class CronAttemptExecutor {
  private readonly logger: LoggerService;

  constructor(private readonly deps: CronAttemptExecutorDeps) {
    this.logger = deps.logger.child({ component: "cron-attempt-executor" });
  }

  async execute(worker: WorkerRecord, job: JobRecord, controller: AbortController): Promise<void> {
    const workerId = worker.id;
    let attempt: AttemptRecord | null = null;
    const jobLogger = this.logger.child({ workerId, workerSlot: worker.slot, jobId: job.id, cronJobId: job.cronJobId });

    try {
      if (job.jobKind !== "cron" || !job.cronJobId) {
        throw new ForemanError("invalid_cron_job", `Job ${job.id} is not a cron job.`, 500);
      }

      const cronJob = (await discoverCronJobs(this.deps.config, this.deps.paths)).find((candidate) => candidate.id === job.cronJobId);
      if (!cronJob) {
        throw new ForemanError("cron_job_not_found", `Cron job file no longer exists: ${job.cronJobId}`, 404);
      }

      const runnerConfig = runnerForAction(this.deps.config, "cron");
      const leaseExpiresAt = addSeconds(new Date(), this.deps.config.scheduler.leaseTtlSeconds);
      attempt = this.deps.foremanRepos.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId,
        runnerName: runnerConfig.type,
        runnerModel: runnerConfig.model,
        runnerVariant: runnerTuningValue(runnerConfig),
        expiresAt: leaseExpiresAt,
        leases: [{ resourceType: "cron", resourceKey: job.dedupeKey }],
      });
      if (!attempt) {
        const nextEligibleAt = nextLeaseConflictEligibleAt(this.deps.config);
        this.deps.foremanRepos.jobs.returnLeasedJobToQueue(job.id, { nextEligibleAt });
        jobLogger.warn("returned leased cron job to queue because required execution leases could not be acquired", { nextEligibleAt });
        return;
      }

      const attemptLogger = jobLogger.child({ attemptId: attempt.id });
      this.deps.foremanRepos.workers.updateWorkerStatus(workerId, "running", attempt.id);
      this.deps.foremanRepos.jobs.updateJobStatus(job.id, "running", { startedAt: attempt.startedAt });
      this.deps.foremanRepos.attempts.addAttemptEvent(attempt.id, "attempt_started", `Started cron job ${cronJob.id}`);
      this.deps.onWorkerUpdated({ workerId, status: "running", attemptId: attempt.id });
      this.deps.onAttemptChanged({ attemptId: attempt.id, status: "running" });

      const heartbeat = setInterval(() => {
        this.deps.foremanRepos.workers.heartbeatWorker(workerId, attempt?.id ?? null, addSeconds(new Date(), this.deps.config.scheduler.leaseTtlSeconds));
        attemptLogger.debug("sent worker heartbeat");
      }, this.deps.config.scheduler.workerHeartbeatSeconds * 1000);

      try {
        const prompt = await renderCronPrompt({ config: this.deps.config, paths: this.deps.paths, repos: this.deps.repos, job: cronJob });
        const promptRelativePath = path.join("artifacts", `attempt-${attempt.id}-prompt.md`);
        const promptAbsolutePath = path.join(this.deps.paths.workspaceRoot, promptRelativePath);
        await atomicWriteFile(promptAbsolutePath, prompt);
        const promptStat = await fs.stat(promptAbsolutePath);
        this.deps.foremanRepos.artifacts.createArtifact({
          ownerType: "execution_attempt",
          ownerId: attempt.id,
          artifactType: "rendered_prompt",
          relativePath: promptRelativePath,
          mediaType: "text/markdown",
          sizeBytes: promptStat.size,
          sha256: await sha256File(promptAbsolutePath),
        });

        const runner = createAgentRunner({ config: this.deps.config, action: "cron" });
        const runResult = await runner.invoke({
          attemptId: attempt.id,
          action: "cron",
          cwd: this.deps.paths.workspaceRoot,
          env: this.deps.env,
          prompt,
          timeoutMs: runnerConfig.timeoutMs,
          abortSignal: controller.signal,
          onStdoutLine: (line) => attemptLogger.runnerLine(line),
          onStderrLine: (line) => attemptLogger.runnerLine(line),
        });
        attemptLogger.info("cron runner invocation completed", {
          exitCode: runResult.exitCode,
          signal: runResult.signal,
          stdoutBytes: runResult.stdoutBytes,
          stderrBytes: runResult.stderrBytes,
        });

        const outputRelativePath = path.join("artifacts", `attempt-${attempt.id}-runner-output.txt`);
        const outputAbsolutePath = path.join(this.deps.paths.workspaceRoot, outputRelativePath);
        await atomicWriteFile(outputAbsolutePath, runResult.stdout);
        const outputStat = await fs.stat(outputAbsolutePath);
        this.deps.foremanRepos.artifacts.createArtifact({
          ownerType: "execution_attempt",
          ownerId: attempt.id,
          artifactType: "runner_output",
          relativePath: outputRelativePath,
          mediaType: "text/plain",
          sizeBytes: outputStat.size,
          sha256: await sha256File(outputAbsolutePath),
        });

        const logRelativePath = path.join("logs", "attempts", `${attempt.id}.log`);
        const logAbsolutePath = path.join(this.deps.paths.workspaceRoot, logRelativePath);
        await ensureDir(path.dirname(logAbsolutePath));
        await attemptLogger.flush();
        const logStat = await fs.stat(logAbsolutePath);
        this.deps.foremanRepos.artifacts.createArtifact({
          ownerType: "execution_attempt",
          ownerId: attempt.id,
          artifactType: "log",
          relativePath: logRelativePath,
          mediaType: "text/plain",
          sizeBytes: logStat.size,
          sha256: await sha256File(logAbsolutePath),
        });

        const attemptStatus = cronAttemptStatus({ exitCode: runResult.exitCode, signal: runResult.signal, aborted: controller.signal.aborted });
        const jobStatus = attemptStatus === "timed_out" ? "failed" : attemptStatus;
        const summary = summarizeOutput(runResult.stdout, attemptStatus);
        this.deps.foremanRepos.attempts.addAttemptEvent(attempt.id, "runner_output_recorded", summary);
        this.deps.foremanRepos.attempts.finalizeAttempt(attempt.id, attemptStatus, {
          finishedAt: runResult.finishedAt,
          exitCode: runResult.exitCode,
          signal: runResult.signal,
          summary,
          errorMessage: attemptStatus === "failed" || attemptStatus === "timed_out" ? summary : null,
          tokensUsed: runResult.tokensUsed ?? null,
        });
        this.deps.foremanRepos.jobs.updateJobStatus(job.id, jobStatus, {
          finishedAt: runResult.finishedAt,
          errorMessage: attemptStatus === "failed" || attemptStatus === "timed_out" ? summary : null,
        });
        this.deps.onAttemptChanged({ attemptId: attempt.id, status: attemptStatus });
        attemptLogger.info("finalized cron attempt and job", { attemptStatus, jobStatus });
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt) {
        this.deps.foremanRepos.attempts.addAttemptEvent(attempt.id, "attempt_failed", message);
        this.deps.foremanRepos.attempts.finalizeAttempt(attempt.id, controller.signal.aborted ? "canceled" : "failed", {
          finishedAt: isoNow(),
          summary: message,
          errorMessage: message,
        });
        this.deps.onAttemptChanged({ attemptId: attempt.id, status: controller.signal.aborted ? "canceled" : "failed" });
      }
      this.deps.foremanRepos.jobs.updateJobStatus(job.id, controller.signal.aborted ? "canceled" : "failed", {
        finishedAt: isoNow(),
        errorMessage: message,
      });
      jobLogger.error("cron job failed", { error: message, aborted: controller.signal.aborted });
    } finally {
      if (attempt) {
        this.deps.foremanRepos.leases.releaseLeasesForAttempt(attempt.id, controller.signal.aborted ? "stopped" : "completed");
      }
      this.deps.foremanRepos.workers.updateWorkerStatus(workerId, "idle", null);
      this.deps.onWorkerUpdated({ workerId, status: "idle" });
      jobLogger.info("worker returned to idle");
      this.deps.onWorkerFinished();
    }
  }
}
