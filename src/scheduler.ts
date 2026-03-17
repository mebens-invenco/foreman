import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkspaceConfig, WorkspacePaths } from "./config.js";
import { deriveAttemptStatus, type ActionType, type RepoRef, type ReviewContext, type Task, type TaskComment, type WorkerResult } from "./domain/index.js";
import { ForemanError } from "./lib/errors.js";
import { atomicWriteFile, ensureDir, pathExists, sha256File } from "./lib/fs.js";
import type { LoggerService } from "./logger.js";
import { isoNow, addMilliseconds, addSeconds } from "./lib/time.js";
import { renderWorkerPrompt } from "./prompts.js";
import type { AttemptRecord, ForemanRepos, JobRecord, WorkerRecord } from "./repos/index.js";
import type { ReviewService } from "./review.js";
import type { CapturedAgentRunResult, OpenCodeRunner } from "./runner.js";
import { parseWorkerResult } from "./runner.js";
import { assertTaskActionableRepo, leaseResourceKeysForAction, runScoutSelection } from "./scout.js";
import type { TaskSystem } from "./task-system.js";
import { validateWorkerResult } from "./worker-result.js";
import { ensureTaskWorktree, removeCleanWorktree } from "./worktrees.js";

export type SchedulerStatus = "running" | "paused" | "stopped";
type ScoutTrigger = "startup" | "poll" | "worker_finished" | "task_mutation" | "lease_change" | "manual";

type SchedulerDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  runner: OpenCodeRunner;
  repos: RepoRef[];
  env: Record<string, string>;
  logger: LoggerService;
};

const consolidationLabels = (config: WorkspaceConfig): { remove: string[]; add: string[] } => {
  if (config.taskSystem.type === "linear") {
    return {
      remove: config.taskSystem.linear!.includeLabels,
      add: [config.taskSystem.linear!.consolidatedLabel],
    };
  }

  return {
    remove: ["Agent"],
    add: ["Agent Consolidated"],
  };
};

const ensureAgentPrefix = (body: string, agentPrefix: string): string =>
  body.startsWith(agentPrefix) ? body : `${agentPrefix}${body}`;

export class SchedulerService extends EventEmitter {
  private status: SchedulerStatus = "stopped";
  private scoutInFlight = false;
  private pendingScoutTrigger: ScoutTrigger | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private loopTimer: NodeJS.Timeout | null = null;
  private reapTimer: NodeJS.Timeout | null = null;
  private nextPollAt: string | null = null;
  private readonly workerAbortControllers = new Map<string, AbortController>();
  private readonly activeWorkerRuns = new Map<string, Promise<void>>();
  private currentScoutPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly logger: LoggerService;

  constructor(private readonly deps: SchedulerDeps) {
    super();
    this.logger = deps.logger.child({ component: "scheduler" });
    this.deps.foremanRepos.workers.ensureWorkerSlots(deps.config.scheduler.workerConcurrency);
    this.logger.info("ensured worker slots", { workerConcurrency: deps.config.scheduler.workerConcurrency });
  }

  getStatus(): { status: SchedulerStatus; nextScoutPollAt: string | null } {
    return { status: this.status, nextScoutPollAt: this.nextPollAt };
  }

  async start(): Promise<void> {
    if (this.status === "running") {
      this.logger.debug("scheduler start ignored because it is already running");
      return;
    }

    if (this.stopPromise) {
      this.logger.info("waiting for scheduler stop to finish before starting again");
      await this.stopPromise;
    }

    const recovered = this.deps.foremanRepos.attempts.recoverOrphanedRunningAttempts(
      "Recovered abandoned attempt on scheduler startup after prior shutdown",
    );
    if (recovered.length > 0) {
      this.logger.warn("recovered orphaned running attempts on startup", {
        recoveredCount: recovered.length,
        attemptIds: recovered.map((entry) => entry.attemptId).join(","),
      });
    }

    this.status = "running";
    this.emit("scheduler_status_changed", { status: this.status });
    this.logger.info("scheduler started");
    this.armTimers();
    this.scheduleScout("startup");
  }

  pause(): void {
    if (this.status === "paused") {
      this.logger.debug("scheduler pause ignored because it is already paused");
      return;
    }

    this.status = "paused";
    this.emit("scheduler_status_changed", { status: this.status });
    this.logger.info("scheduler paused");
    this.clearPollTimer();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    if (this.status === "stopped" && this.activeWorkerRuns.size === 0 && !this.currentScoutPromise) {
      this.logger.debug("scheduler stop ignored because it is already stopped");
      return;
    }

    this.status = "stopped";
    this.emit("scheduler_status_changed", { status: this.status });
    this.logger.info("scheduler stopping", { activeWorkers: this.workerAbortControllers.size });
    this.clearTimers();
    this.pendingScoutTrigger = null;

      for (const worker of this.deps.foremanRepos.workers.listWorkers()) {
        if (this.workerAbortControllers.has(worker.id)) {
          this.deps.foremanRepos.workers.updateWorkerStatus(worker.id, "stopping", worker.currentAttemptId);
        }
      }

    for (const controller of this.workerAbortControllers.values()) {
      controller.abort();
    }

    this.stopPromise = (async () => {
      if (this.currentScoutPromise) {
        this.logger.info("waiting for in-flight scout run to finish during shutdown");
        await this.currentScoutPromise;
      }

      const activeRuns = [...this.activeWorkerRuns.values()];
      if (activeRuns.length > 0) {
        const drainPromise = Promise.allSettled(activeRuns);
        const gracePeriodMs = this.deps.config.scheduler.shutdownGracePeriodSeconds * 1000;
        let graceTimer: NodeJS.Timeout | null = null;
        const completedWithinGrace = await Promise.race([
          drainPromise.then(() => true),
          new Promise<boolean>((resolve) => {
            graceTimer = setTimeout(() => resolve(false), gracePeriodMs);
          }),
        ]);
        if (graceTimer) {
          clearTimeout(graceTimer);
        }

        if (!completedWithinGrace) {
          this.logger.warn("shutdown grace period exceeded while waiting for worker cleanup", {
            activeWorkers: activeRuns.length,
            shutdownGracePeriodSeconds: this.deps.config.scheduler.shutdownGracePeriodSeconds,
          });
          await drainPromise;
        }
      }

      this.logger.info("scheduler stopped");
    })().finally(() => {
      this.stopPromise = null;
    });

    await this.stopPromise;
  }

  triggerManualScout(): void {
    this.logger.info("manual scout requested");
    this.scheduleScout("manual");
  }

  private armTimers(): void {
    this.clearTimers();
    this.nextPollAt = addSeconds(new Date(), this.deps.config.scheduler.scoutPollIntervalSeconds);
    this.logger.debug("armed scheduler timers", {
      nextScoutPollAt: this.nextPollAt,
      scoutPollIntervalSeconds: this.deps.config.scheduler.scoutPollIntervalSeconds,
      schedulerLoopIntervalMs: this.deps.config.scheduler.schedulerLoopIntervalMs,
      staleLeaseReapIntervalSeconds: this.deps.config.scheduler.staleLeaseReapIntervalSeconds,
    });
    this.pollTimer = setTimeout(() => {
      this.scheduleScout("poll");
    }, this.deps.config.scheduler.scoutPollIntervalSeconds * 1000);

    this.loopTimer = setInterval(() => {
      void this.dispatchQueuedJobs();
    }, this.deps.config.scheduler.schedulerLoopIntervalMs);

    this.reapTimer = setInterval(() => {
      const changes = this.deps.foremanRepos.leases.reapExpiredLeases(isoNow());
      if (changes > 0) {
        this.logger.warn("reaped expired leases", { changes });
        this.scheduleScout("lease_change");
      }
    }, this.deps.config.scheduler.staleLeaseReapIntervalSeconds * 1000);
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.nextPollAt = null;
  }

  private clearTimers(): void {
    this.clearPollTimer();
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  private scheduleScout(trigger: ScoutTrigger): void {
    if (this.status !== "running" && trigger !== "manual") {
      this.logger.debug("ignored scout scheduling because scheduler is not running", { trigger, status: this.status });
      return;
    }

    if (this.scoutInFlight) {
      this.pendingScoutTrigger = trigger;
      this.logger.debug("queued follow-up scout trigger", { trigger });
      return;
    }

    const delay = trigger === "startup" ? 0 : this.deps.config.scheduler.scoutRerunDebounceMs;
    this.logger.info("scheduled scout run", { trigger, delayMs: delay });
    setTimeout(() => {
      const runPromise = this.runScout(trigger).finally(() => {
        if (this.currentScoutPromise === runPromise) {
          this.currentScoutPromise = null;
        }
      });
      this.currentScoutPromise = runPromise;
      void runPromise;
    }, delay);
  }

  private async runScout(trigger: ScoutTrigger): Promise<void> {
    if (this.status !== "running" && trigger !== "manual") {
      this.logger.debug("skipped scout run because scheduler is not running", { trigger, status: this.status });
      return;
    }

    if (this.scoutInFlight) {
      this.pendingScoutTrigger = trigger;
      this.logger.debug("runScout deferred because another scout is in flight", { trigger });
      return;
    }

    this.scoutInFlight = true;
    this.logger.info("starting scout run", { trigger });
    try {
      const selection = await runScoutSelection({
        config: this.deps.config,
        foremanRepos: this.deps.foremanRepos,
        taskSystem: this.deps.taskSystem,
        reviewService: this.deps.reviewService,
        repos: this.deps.repos,
        triggerType: trigger,
        logger: this.logger.child({ component: "scout", trigger }),
      });

      if (this.status !== "running" && trigger !== "manual") {
        this.deps.foremanRepos.scoutRuns.completeScoutRun({
          id: selection.scoutRunId,
          summary: { enqueued: 0, skippedBecauseStopped: true },
        });
        this.logger.info("discarded scout selection because scheduler stopped", {
          trigger,
          scoutRunId: selection.scoutRunId,
        });
        return;
      }

      let firstJobId: string | null = null;
      let firstAction: ActionType | null = null;
      let firstTaskId: string | null = null;
      let firstReason = "";

      for (const selected of selection.jobs) {
          const job = this.deps.foremanRepos.jobs.createJob({
          taskId: selected.task.id,
          taskProvider: selected.task.provider,
          action: selected.action,
          priorityRank: selected.priorityRank,
          repoKey: selected.repo.key,
          baseBranch: selected.baseBranch,
          dedupeKey: `${selected.task.id}:${selected.action}`,
          selectionReason: selected.selectionReason,
          selectionContext: selected.selectionContext,
          scoutRunId: selection.scoutRunId,
        });

        if (!firstJobId) {
          firstJobId = job.id;
          firstAction = selected.action;
          firstTaskId = selected.task.id;
          firstReason = selected.selectionReason;
        }

        this.logger.info("enqueued job from scout selection", {
          trigger,
          jobId: job.id,
          taskId: selected.task.id,
          action: selected.action,
          repo: selected.repo.key,
          reason: selected.selectionReason,
        });
      }

      this.deps.foremanRepos.scoutRuns.completeScoutRun({
        id: selection.scoutRunId,
        selectedJobId: firstJobId,
        selectedAction: firstAction,
        selectedTaskId: firstTaskId,
        selectedReason: firstReason,
        summary: { enqueued: selection.jobs.length },
      });

      if (selection.jobs.length > 0) {
        this.emit("scout_completed", { enqueued: selection.jobs.length });
      }
      this.logger.info("completed scout run", {
        trigger,
        scoutRunId: selection.scoutRunId,
        enqueued: selection.jobs.length,
        selectedJobId: firstJobId,
        selectedTaskId: firstTaskId,
        selectedAction: firstAction,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("scout run failed", { trigger, error: message });
        const scoutRuns = this.deps.foremanRepos.scoutRuns.listScoutRuns(1);
      const latestId = String(scoutRuns[0]?.id ?? "");
      if (latestId) {
          this.deps.foremanRepos.scoutRuns.completeScoutRun({
          id: latestId,
          status: "failed",
          errorMessage: message,
          summary: { error: message },
        });
      }
    } finally {
      this.scoutInFlight = false;
      if (this.status === "running") {
        this.armTimers();
      }

      if (this.pendingScoutTrigger) {
        const followUp = this.pendingScoutTrigger;
        this.pendingScoutTrigger = null;
        this.logger.info("running queued follow-up scout", { trigger: followUp });
        this.scheduleScout(followUp);
      }
    }
  }

  private async dispatchQueuedJobs(): Promise<void> {
    if (this.status !== "running") {
      return;
    }

    const queuedJobs = this.deps.foremanRepos.jobs.listJobsByStatus(["queued"]);
    const idleWorkers = this.deps.foremanRepos.workers
      .listWorkers()
      .filter((worker) => worker.status === "idle" && !this.activeWorkerRuns.has(worker.id));
    if (queuedJobs.length > 0 || idleWorkers.length > 0) {
      this.logger.debug("checked dispatch queue", { queuedJobs: queuedJobs.length, idleWorkers: idleWorkers.length });
    }

    for (const worker of idleWorkers) {
      if (this.status !== "running") {
        break;
      }

      const job = queuedJobs.shift();
      if (!job) {
        break;
      }

      const claimed = this.deps.foremanRepos.jobs.claimQueuedJobForWorker(job.id, worker.id);
      if (!claimed) {
        this.logger.debug("skipped dispatch because worker or job was already claimed", {
          workerId: worker.id,
          jobId: job.id,
          taskId: job.taskId,
          action: job.action,
        });
        continue;
      }

      this.logger.info("dispatching queued job to worker", { workerId: worker.id, jobId: job.id, taskId: job.taskId, action: job.action });
      const runPromise = this.runJob(worker, job).finally(() => {
        if (this.activeWorkerRuns.get(worker.id) === runPromise) {
          this.activeWorkerRuns.delete(worker.id);
        }
      });
      this.activeWorkerRuns.set(worker.id, runPromise);
      void runPromise;
    }
  }

  private async runJob(worker: WorkerRecord, job: JobRecord): Promise<void> {
    const workerId = worker.id;
    const controller = new AbortController();
    this.workerAbortControllers.set(workerId, controller);
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
    let currentPrUrl: string | null = null;

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
      this.emit("worker_updated", { workerId, status: "running", attemptId: attempt.id });
      this.emit("attempt_changed", { attemptId: attempt.id, status: "running" });

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
        const promptInput = {
          action: job.action,
          config: this.deps.config,
          paths: this.deps.paths,
          task,
          comments: comments.map((comment) => `- ${comment.createdAt} ${comment.authorName ?? "unknown"}: ${comment.body}`).join("\n") || "(none)",
          repo,
          worktreePath,
          baseBranch: job.baseBranch ?? repo.defaultBranch,
          ...(reviewContext ? { reviewContext } : {}),
        };
        const prompt = await renderWorkerPrompt(promptInput);
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
        } as Parameters<OpenCodeRunner["invoke"]>[0]) as CapturedAgentRunResult;
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

        currentPrUrl = await this.applyWorkerResult({
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
        this.emit("attempt_changed", { attemptId: attempt.id, status: controller.signal.aborted ? "canceled" : "failed" });
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
      this.emit("worker_updated", { workerId, status: "idle" });
      this.workerAbortControllers.delete(workerId);
      jobLogger.info("worker returned to idle");
      this.scheduleScout("worker_finished");
    }
  }

  private async applyWorkerResult(input: {
    attempt: AttemptRecord;
    job: JobRecord;
    task: Task;
    repo: RepoRef;
    worktreePath: string;
    workerResult: WorkerResult;
  }): Promise<string | null> {
    const { workerResult } = input;
    let pullRequestUrl = await this.resolveCurrentPullRequestUrl(input.task, input.repo);
    const logger = this.logger.child({
      component: "scheduler.applyWorkerResult",
      attemptId: input.attempt.id,
      jobId: input.job.id,
      taskId: input.task.id,
      action: input.job.action,
      outcome: workerResult.outcome,
    });
    logger.info("applying worker result mutations");

    if (workerResult.outcome === "blocked") {
      for (const blocker of workerResult.blockers) {
        await this.deps.taskSystem.addComment({
          taskId: input.task.id,
          body: `${this.deps.config.workspace.agentPrefix}${blocker.code}: ${blocker.message}`,
        });
        logger.warn("posted blocker comment", { blockerCode: blocker.code });
      }
      return pullRequestUrl;
    }

    if (workerResult.outcome === "failed") {
      logger.warn("worker result marked attempt as failed; skipping side effects");
      return pullRequestUrl;
    }

    const createOrReopen = workerResult.reviewMutations.filter(
      (mutation) => mutation.type === "create_pull_request" || mutation.type === "reopen_pull_request",
    );
    const requiresPullRequest =
      input.job.action === "execution" &&
      workerResult.outcome === "completed" &&
      workerResult.signals.includes("code_changed");

    for (const mutation of createOrReopen) {
      if (mutation.type === "create_pull_request") {
        const created = await this.deps.reviewService.createPullRequest({
          cwd: input.worktreePath,
          title: mutation.title,
          body: mutation.body,
          draft: mutation.draft,
          baseBranch: mutation.baseBranch,
          headBranch: mutation.headBranch,
        });
        pullRequestUrl = created.url;
        await this.deps.taskSystem.addArtifact({
          taskId: input.task.id,
          artifact: { type: "pull_request", url: created.url, title: mutation.title, externalId: String(created.number) },
        });
        await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "in_review" });
        logger.info("created pull request", { pullRequestUrl: created.url, pullRequestNumber: created.number });
      }

      if (mutation.type === "reopen_pull_request") {
        const reopened = await this.deps.reviewService.reopenPullRequest({
          cwd: input.worktreePath,
          draft: mutation.draft,
          ...(mutation.pullRequestUrl ? { pullRequestUrl: mutation.pullRequestUrl } : {}),
          ...(mutation.pullRequestNumber ? { pullRequestNumber: mutation.pullRequestNumber } : {}),
          ...(mutation.title ? { title: mutation.title } : {}),
          ...(mutation.body ? { body: mutation.body } : {}),
        });
        pullRequestUrl = reopened.url;
        await this.deps.taskSystem.addArtifact({
          taskId: input.task.id,
          artifact: {
            type: "pull_request",
            url: reopened.url,
            ...(mutation.title ? { title: mutation.title } : {}),
            externalId: String(reopened.number),
          },
        });
        await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "in_review" });
        logger.info("reopened pull request", { pullRequestUrl: reopened.url, pullRequestNumber: reopened.number });
      }
    }

    if (requiresPullRequest && createOrReopen.length === 0) {
      if (!pullRequestUrl) {
        throw new ForemanError(
          "missing_pull_request",
          "Execution results with code changes must include a create_pull_request or reopen_pull_request mutation",
        );
      }

      await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "in_review" });
      logger.info("transitioned task to in_review using existing pull request artifact", { pullRequestUrl });
    }

    if (input.job.action === "execution" && workerResult.outcome === "no_action_needed") {
      const resolvedPullRequest = await this.deps.reviewService.resolvePullRequest(input.task, input.repo);
      if (resolvedPullRequest?.state === "open") {
        pullRequestUrl = resolvedPullRequest.pullRequestUrl;
        await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "in_review" });
        logger.info("transitioned task to in_review after execution no-op on open pull request", { pullRequestUrl });
      }
    }

    for (const mutation of workerResult.reviewMutations) {
      if (mutation.type === "create_pull_request" || mutation.type === "reopen_pull_request") {
        continue;
      }

      if (!pullRequestUrl) {
        throw new ForemanError("missing_pull_request", `Review mutation ${mutation.type} requires a pull request URL`);
      }

      if (mutation.type === "reply_to_review_summary") {
        await this.deps.reviewService.replyToReviewSummary(
          pullRequestUrl,
          mutation.reviewId,
          ensureAgentPrefix(mutation.body, this.deps.config.workspace.agentPrefix),
        );
        logger.info("replied to review summary", { reviewId: mutation.reviewId });
      }
      if (mutation.type === "reply_to_thread_comment") {
        await this.deps.reviewService.replyToThreadComment(
          pullRequestUrl,
          mutation.threadId,
          ensureAgentPrefix(mutation.body, this.deps.config.workspace.agentPrefix),
        );
        logger.info("replied to review thread", { threadId: mutation.threadId });
      }
      if (mutation.type === "reply_to_pr_comment") {
        await this.deps.reviewService.replyToPrComment(
          pullRequestUrl,
          mutation.commentId,
          ensureAgentPrefix(mutation.body, this.deps.config.workspace.agentPrefix),
        );
        logger.info("replied to pull request comment", { commentId: mutation.commentId });
      }
      if (mutation.type === "resolve_threads") {
        await this.deps.reviewService.resolveThreads(pullRequestUrl, mutation.threadIds);
        logger.info("resolved review threads", { threadCount: mutation.threadIds.length });
      }
    }

    for (const mutation of workerResult.taskMutations) {
      if (mutation.type === "add_comment") {
        await this.deps.taskSystem.addComment({ taskId: input.task.id, body: mutation.body });
        logger.info("added task comment from worker mutation");
      }
    }

    if (input.job.action === "consolidation" && workerResult.outcome === "completed") {
      const labels = consolidationLabels(this.deps.config);
      await this.deps.taskSystem.updateLabels({
        taskId: input.task.id,
        add: labels.add,
        remove: labels.remove,
      });
      logger.info("updated consolidation labels", { addCount: labels.add.length, removeCount: labels.remove.length });
    }

    for (const mutation of workerResult.learningMutations) {
      if (mutation.type === "add") {
          this.deps.foremanRepos.learnings.addLearning(mutation);
        logger.info("added learning mutation", { learningTitle: mutation.title, repo: mutation.repo });
      }
      if (mutation.type === "update") {
          this.deps.foremanRepos.learnings.updateLearning(mutation);
        logger.info("updated learning mutation", { learningId: mutation.id });
      }
    }

    if (
      input.job.action === "review" &&
      workerResult.outcome === "no_action_needed" &&
      workerResult.signals.includes("review_checkpoint_eligible") &&
      pullRequestUrl
    ) {
      const reviewContext = await this.deps.reviewService.getContext(input.task, this.deps.config.workspace.agentPrefix, input.repo);
      if (reviewContext) {
        try {
            this.deps.foremanRepos.reviewCheckpoints.upsertReviewCheckpoint({
            taskId: input.task.id,
            prUrl: pullRequestUrl,
            reviewContext,
            sourceAttemptId: input.attempt.id,
          });
          logger.info("saved review checkpoint", { pullRequestUrl });
        } catch (error) {
            this.deps.foremanRepos.attempts.addAttemptEvent(
              input.attempt.id,
              "review_checkpoint_warning",
              error instanceof Error ? error.message : String(error),
          );
          logger.warn("failed to save review checkpoint", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    this.scheduleScout("task_mutation");
    logger.info("scheduled follow-up scout after task mutations", { pullRequestUrl });
    return pullRequestUrl;
  }

  private async resolveCurrentPullRequestUrl(task: Task, repo: RepoRef): Promise<string | null> {
    const resolvedPullRequest = await this.deps.reviewService.resolvePullRequest(task, repo);
    return resolvedPullRequest?.pullRequestUrl ?? null;
  }

  private async gitHead(cwd: string): Promise<string> {
    const { exec } = await import("./lib/process.js");
    return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  }
}
