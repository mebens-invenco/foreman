import { EventEmitter } from "node:events";

import type { ActionType, RepoRef, Task, TaskTarget, WorkerResult } from "../domain/index.js";
import type { AgentRunner } from "../execution/index.js";
import { addSeconds, isoNow } from "../lib/time.js";
import type { LoggerService } from "../logger.js";
import type { AttemptRecord, ForemanRepos, JobRecord, WorkerRecord } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";
import { AttemptExecutor } from "./attempt-executor.js";
import { runScoutSelection } from "./scout-selection.js";
import { WorkerResultApplier } from "./worker-result-applier.js";

export type SchedulerStatus = "running" | "paused" | "stopping" | "stopped";
type ScoutTrigger = "startup" | "poll" | "worker_finished" | "task_mutation" | "lease_change" | "manual";

type SchedulerDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  runner: AgentRunner;
  repos: RepoRef[];
  env: Record<string, string>;
  logger: LoggerService;
};

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
  private readonly workerResultApplier: WorkerResultApplier;
  private readonly attemptExecutor: AttemptExecutor;

  constructor(private readonly deps: SchedulerDeps) {
    super();
    this.logger = deps.logger.child({ component: "scheduler" });
    this.deps.foremanRepos.workers.ensureWorkerSlots(deps.config.scheduler.workerConcurrency);
    this.logger.info("ensured worker slots", { workerConcurrency: deps.config.scheduler.workerConcurrency });

    this.workerResultApplier = new WorkerResultApplier({
      config: deps.config,
      foremanRepos: deps.foremanRepos,
      taskSystem: deps.taskSystem,
      reviewService: deps.reviewService,
      logger: this.logger,
      scheduleScout: () => this.scheduleScout("task_mutation"),
    });
    this.attemptExecutor = new AttemptExecutor({
      config: deps.config,
      paths: deps.paths,
      foremanRepos: deps.foremanRepos,
      taskSystem: deps.taskSystem,
      reviewService: deps.reviewService,
      runner: deps.runner,
      repos: deps.repos,
      env: deps.env,
      logger: this.logger,
      applyWorkerResult: (input) => this.applyWorkerResult(input),
      onWorkerUpdated: ({ workerId, status, attemptId }) => {
        this.emit("worker_updated", { workerId, status, ...(attemptId ? { attemptId } : {}) });
      },
      onAttemptChanged: ({ attemptId, status }) => {
        this.emit("attempt_changed", { attemptId, status });
      },
      onWorkerFinished: () => {
        this.scheduleScout("worker_finished");
      },
    });
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

    if (this.status !== "running") {
      this.logger.debug("scheduler pause ignored because it is not running", { status: this.status });
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

    this.status = "stopping";
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

      this.status = "stopped";
      this.emit("scheduler_status_changed", { status: this.status });
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
          taskTargetId: selected.target.id,
          taskProvider: selected.task.provider,
          action: selected.action,
          priorityRank: selected.priorityRank,
          repoKey: selected.repo.key,
          baseBranch: selected.baseBranch,
          dedupeKey: `${selected.task.id}:${selected.target.repoKey}:${selected.action}`,
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
    const controller = new AbortController();
    this.workerAbortControllers.set(worker.id, controller);
    try {
      await this.attemptExecutor.execute(worker, job, controller);
    } finally {
      if (this.workerAbortControllers.get(worker.id) === controller) {
        this.workerAbortControllers.delete(worker.id);
      }
    }
  }

  private async applyWorkerResult(input: {
    attempt: AttemptRecord;
    job: JobRecord;
    task: Task;
    target: TaskTarget;
    repo: RepoRef;
    worktreePath: string;
    workerResult: WorkerResult;
  }): Promise<string | null> {
    return this.workerResultApplier.apply(input);
  }
}
