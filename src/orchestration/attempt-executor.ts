import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkspaceConfig, WorkspacePaths } from "../config.js";
import { deriveAttemptStatus, type RepoRef, type Task, type WorkerResult } from "../domain/index.js";
import type { AgentRunner } from "../execution/index.js";
import { parseWorkerResult, validateWorkerResult } from "../execution/index.js";
import { ForemanError } from "../lib/errors.js";
import { atomicWriteFile, ensureDir, pathExists, sha256File } from "../lib/fs.js";
import { addSeconds, isoNow } from "../lib/time.js";
import type { LoggerService } from "../logger.js";
import { renderWorkerPrompt } from "../prompts.js";
import type { AttemptRecord, ForemanRepos, JobRecord, WorkerRecord } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import { ensureTaskWorktree, removeCleanWorktree } from "../worktrees.js";
import { assertTaskActionableRepo, leaseResourceKeysForAction } from "./scout-selection.js";

type AttemptExecutorDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  runner: AgentRunner;
  repos: RepoRef[];
  env: Record<string, string>;
  logger: LoggerService;
  applyWorkerResult: (input: {
    attempt: AttemptRecord;
    job: JobRecord;
    task: Task;
    repo: RepoRef;
    worktreePath: string;
    workerResult: WorkerResult;
  }) => Promise<string | null>;
  onWorkerUpdated: (input: { workerId: string; status: string; attemptId?: string | null }) => void;
  onAttemptChanged: (input: { attemptId: string; status: string }) => void;
  onWorkerFinished: () => void;
};

export class AttemptExecutor {
  private readonly logger: LoggerService;

  constructor(private readonly deps: AttemptExecutorDeps) {
    this.logger = deps.logger.child({ component: "attempt-executor" });
  }

  async execute(worker: WorkerRecord, job: JobRecord, controller: AbortController): Promise<void> {
    const workerId = worker.id;
    let jobLogger = this.logger.child({
      workerId,
      workerSlot: worker.slot,
      jobId: job.id,
      taskId: job.taskId,
      action: job.action,
      repo: job.repoKey,
    });
    jobLogger.info("starting job on worker");

    let attempt: AttemptRecord | null = null;
    let task: Task | null = null;
    let repo: RepoRef | null = null;
    let worktreePath: string | null = null;
    let beforeSha: string | null = null;

    try {
      task = await this.deps.taskSystem.getTask(job.taskId);
      repo = assertTaskActionableRepo(task, this.deps.repos);
      jobLogger = jobLogger.child({ taskState: task.state, repo: repo.key });
      jobLogger.info("loaded task and resolved repo", { baseBranch: job.baseBranch ?? repo.defaultBranch });
      const leaseExpiresAt = addSeconds(new Date(), this.deps.config.scheduler.leaseTtlSeconds);

      attempt = this.deps.foremanRepos.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId,
        runnerModel: this.deps.config.runner.model,
        runnerVariant: this.deps.config.runner.variant,
        expiresAt: leaseExpiresAt,
        leases: leaseResourceKeysForAction(task, job.action),
      });
      if (!attempt) {
        this.deps.foremanRepos.jobs.returnLeasedJobToQueue(job.id);
        jobLogger.warn("returned leased job to queue because required execution leases could not be acquired");
        return;
      }

      const attemptLogger = jobLogger.child({ attemptId: attempt.id });
      attemptLogger.info("created execution attempt", { attemptNumber: attempt.attemptNumber, leaseExpiresAt });

      this.deps.foremanRepos.workers.updateWorkerStatus(workerId, "running", attempt.id);
      this.deps.foremanRepos.jobs.updateJobStatus(job.id, "running", { startedAt: attempt.startedAt });
      this.deps.foremanRepos.attempts.addAttemptEvent(attempt.id, "attempt_started", `Started ${job.action} for ${task.id}`);
      attemptLogger.info("worker leased and job marked running");
      this.deps.onWorkerUpdated({ workerId, status: "running", attemptId: attempt.id });
      this.deps.onAttemptChanged({ attemptId: attempt.id, status: "running" });

      const heartbeat = setInterval(() => {
        this.deps.foremanRepos.workers.heartbeatWorker(
          workerId,
          attempt?.id ?? null,
          addSeconds(new Date(), this.deps.config.scheduler.leaseTtlSeconds),
        );
        attemptLogger.debug("sent worker heartbeat");
      }, this.deps.config.scheduler.workerHeartbeatSeconds * 1000);

      try {
        worktreePath =
          job.action === "consolidation"
            ? path.join(this.deps.paths.worktreesDir, repo.key, task.id)
            : await ensureTaskWorktree({
                paths: this.deps.paths,
                repo,
                task,
                baseBranch: job.baseBranch ?? repo.defaultBranch,
                action: job.action,
              });
        attemptLogger.info("prepared worktree", {
          worktreePath,
          mode: job.action === "consolidation" ? "consolidation" : "task_worktree",
        });

        if (job.action === "execution" || job.action === "retry") {
          await this.deps.taskSystem.transition({ taskId: task.id, toState: "in_progress" });
          attemptLogger.info("transitioned task to in_progress");
        }

        if (await pathExists(worktreePath)) {
          beforeSha = await this.gitHead(worktreePath).catch(() => null);
          attemptLogger.info("resolved worktree head", { beforeSha: beforeSha ?? "unknown" });
        } else {
          worktreePath = repo.rootPath;
          beforeSha = await this.gitHead(worktreePath).catch(() => null);
          attemptLogger.warn("falling back to repository root for worktree path", { worktreePath, beforeSha: beforeSha ?? "unknown" });
        }

        const comments = await this.deps.taskSystem.listComments(task.id);
        const reviewContext =
          job.action === "review" || job.action === "retry"
            ? (await this.deps.reviewService.getContext(task, this.deps.config.workspace.agentPrefix, repo)) ?? undefined
            : undefined;
        const prompt = await renderWorkerPrompt({
          action: job.action,
          config: this.deps.config,
          paths: this.deps.paths,
          task,
          comments: comments.map((comment) => `- ${comment.createdAt} ${comment.authorName ?? "unknown"}: ${comment.body}`).join("\n") || "(none)",
          repo,
          worktreePath,
          baseBranch: job.baseBranch ?? repo.defaultBranch,
          ...(reviewContext ? { reviewContext } : {}),
        });
        attemptLogger.info("rendered worker prompt", { commentCount: comments.length, hasReviewContext: Boolean(reviewContext) });

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
        attemptLogger.info("wrote rendered prompt artifact", { promptPath: promptAbsolutePath, sizeBytes: promptStat.size });

        const runResult = await this.deps.runner.invoke({
          attemptId: attempt.id,
          cwd: worktreePath,
          env: this.deps.env,
          prompt,
          timeoutMs: this.deps.config.runner.timeoutMs,
          abortSignal: controller.signal,
          onStdoutLine: (line: string) => {
            attemptLogger.runnerLine(line);
          },
          onStderrLine: (line: string) => {
            attemptLogger.runnerLine(line);
          },
        });
        attemptLogger.info("runner invocation completed", {
          exitCode: runResult.exitCode,
          signal: runResult.signal,
          stdoutBytes: runResult.stdoutBytes,
          stderrBytes: runResult.stderrBytes,
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
        attemptLogger.info("recorded attempt log artifact", { logPath: logAbsolutePath, sizeBytes: logStat.size });

        let workerResult: WorkerResult;
        try {
          workerResult = validateWorkerResult(parseWorkerResult(runResult.stdout));
        } catch (error) {
          throw new ForemanError("worker_result_invalid", error instanceof Error ? error.message : String(error), 500);
        }
        attemptLogger.info("parsed worker result", { outcome: workerResult.outcome });

        const resultRelativePath = path.join("artifacts", `attempt-${attempt.id}-result.json`);
        const resultAbsolutePath = path.join(this.deps.paths.workspaceRoot, resultRelativePath);
        await atomicWriteFile(resultAbsolutePath, `${JSON.stringify(workerResult, null, 2)}\n`);
        const resultStat = await fs.stat(resultAbsolutePath);
        this.deps.foremanRepos.artifacts.createArtifact({
          ownerType: "execution_attempt",
          ownerId: attempt.id,
          artifactType: "parsed_result",
          relativePath: resultRelativePath,
          mediaType: "application/json",
          sizeBytes: resultStat.size,
          sha256: await sha256File(resultAbsolutePath),
        });
        this.deps.foremanRepos.attempts.addAttemptEvent(attempt.id, "worker_result_parsed", workerResult.summary, {
          outcome: workerResult.outcome,
        });
        attemptLogger.info("wrote parsed worker result artifact", { resultPath: resultAbsolutePath, sizeBytes: resultStat.size });

        const currentPrUrl = await this.deps.applyWorkerResult({
          attempt,
          job,
          task,
          repo,
          worktreePath,
          workerResult,
        });
        attemptLogger.info("applied worker result", { currentPrUrl });

        const attemptStatus = deriveAttemptStatus(workerResult);
        const jobStatus = attemptStatus === "timed_out" ? "failed" : attemptStatus;
        const afterSha = await this.gitHead(worktreePath).catch(() => null);
        this.deps.foremanRepos.attempts.finalizeAttempt(attempt.id, attemptStatus, {
          finishedAt: runResult.finishedAt,
          exitCode: runResult.exitCode,
          signal: runResult.signal,
          summary: workerResult.summary,
          errorMessage: workerResult.outcome === "failed" ? workerResult.summary : null,
        });
        this.deps.foremanRepos.jobs.updateJobStatus(job.id, jobStatus, {
          finishedAt: runResult.finishedAt,
          errorMessage: workerResult.outcome === "failed" ? workerResult.summary : null,
        });
        const historyInput: Parameters<ForemanRepos["history"]["addHistoryStep"]>[0] = {
          createdAt: runResult.finishedAt,
          stage: job.action,
          issue: task.id.toLowerCase(),
          summary: workerResult.summary,
        };
        if (beforeSha && afterSha) {
          historyInput.repos = [{ path: repo.rootPath, beforeSha, afterSha }];
        }
        this.deps.foremanRepos.history.addHistoryStep(historyInput);
        attemptLogger.info("finalized attempt and job", { attemptStatus, jobStatus, afterSha: afterSha ?? "unknown" });

        if (job.action === "consolidation" && workerResult.outcome === "completed" && worktreePath !== repo.rootPath) {
          const removed = await removeCleanWorktree(repo, worktreePath);
          attemptLogger.info("finished consolidation worktree cleanup", { removed, worktreePath });
        }
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt) {
        const attemptLogger = jobLogger.child({ attemptId: attempt.id });
        attemptLogger.error("attempt failed", { error: message, aborted: controller.signal.aborted });
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
      jobLogger.error("job failed", { error: message, aborted: controller.signal.aborted });
    } finally {
      if (attempt) {
        this.deps.foremanRepos.leases.releaseLeasesForAttempt(attempt.id, controller.signal.aborted ? "stopped" : "completed");
        jobLogger.child({ attemptId: attempt.id }).info("released attempt leases", {
          releaseReason: controller.signal.aborted ? "stopped" : "completed",
        });
      }

      this.deps.foremanRepos.workers.updateWorkerStatus(workerId, "idle", null);
      this.deps.onWorkerUpdated({ workerId, status: "idle" });
      jobLogger.info("worker returned to idle");
      this.deps.onWorkerFinished();
    }
  }

  private async gitHead(cwd: string): Promise<string> {
    const { exec } = await import("../lib/process.js");
    return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  }
}
