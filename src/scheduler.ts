import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkspaceConfig, WorkspacePaths } from "./config.js";
import { deriveAttemptStatus, type AttemptRecord, type ForemanDb, type JobRecord } from "./db.js";
import type { ActionType, RepoRef, ReviewContext, Task, TaskComment, WorkerResult } from "./domain.js";
import { ForemanError } from "./lib/errors.js";
import { atomicWriteFile, ensureDir, pathExists, sha256File } from "./lib/fs.js";
import { isoNow, addMilliseconds, addSeconds } from "./lib/time.js";
import { renderWorkerPrompt } from "./prompts.js";
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
  db: ForemanDb;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  runner: OpenCodeRunner;
  repos: RepoRef[];
  env: Record<string, string>;
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

  constructor(private readonly deps: SchedulerDeps) {
    super();
    this.deps.db.ensureWorkerSlots(deps.config.scheduler.workerConcurrency);
  }

  getStatus(): { status: SchedulerStatus; nextScoutPollAt: string | null } {
    return { status: this.status, nextScoutPollAt: this.nextPollAt };
  }

  start(): void {
    if (this.status === "running") {
      return;
    }

    this.status = "running";
    this.emit("scheduler_status_changed", { status: this.status });
    this.armTimers();
    this.scheduleScout("startup");
  }

  pause(): void {
    if (this.status === "paused") {
      return;
    }

    this.status = "paused";
    this.emit("scheduler_status_changed", { status: this.status });
    this.clearPollTimer();
  }

  async stop(): Promise<void> {
    if (this.status === "stopped") {
      return;
    }

    this.status = "stopped";
    this.emit("scheduler_status_changed", { status: this.status });
    this.clearTimers();

    for (const controller of this.workerAbortControllers.values()) {
      controller.abort();
    }
  }

  triggerManualScout(): void {
    this.scheduleScout("manual");
  }

  private armTimers(): void {
    this.clearTimers();
    this.nextPollAt = addSeconds(new Date(), this.deps.config.scheduler.scoutPollIntervalSeconds);
    this.pollTimer = setTimeout(() => {
      this.scheduleScout("poll");
    }, this.deps.config.scheduler.scoutPollIntervalSeconds * 1000);

    this.loopTimer = setInterval(() => {
      void this.dispatchQueuedJobs();
    }, this.deps.config.scheduler.schedulerLoopIntervalMs);

    this.reapTimer = setInterval(() => {
      const changes = this.deps.db.reapExpiredLeases(isoNow());
      if (changes > 0) {
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
      return;
    }

    if (this.scoutInFlight) {
      this.pendingScoutTrigger = trigger;
      return;
    }

    const delay = trigger === "startup" ? 0 : this.deps.config.scheduler.scoutRerunDebounceMs;
    setTimeout(() => {
      void this.runScout(trigger);
    }, delay);
  }

  private async runScout(trigger: ScoutTrigger): Promise<void> {
    if (this.scoutInFlight) {
      this.pendingScoutTrigger = trigger;
      return;
    }

    this.scoutInFlight = true;
    try {
      const selection = await runScoutSelection({
        config: this.deps.config,
        db: this.deps.db,
        taskSystem: this.deps.taskSystem,
        reviewService: this.deps.reviewService,
        repos: this.deps.repos,
        triggerType: trigger,
      });

      let firstJobId: string | null = null;
      let firstAction: ActionType | null = null;
      let firstTaskId: string | null = null;
      let firstReason = "";

      for (const selected of selection.jobs) {
        const job = this.deps.db.createJob({
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
      }

      this.deps.db.completeScoutRun({
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const scoutRuns = this.deps.db.listScoutRuns(1);
      const latestId = String(scoutRuns[0]?.id ?? "");
      if (latestId) {
        this.deps.db.completeScoutRun({
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
        this.scheduleScout(followUp);
      }
    }
  }

  private async dispatchQueuedJobs(): Promise<void> {
    if (this.status !== "running") {
      return;
    }

    const queuedJobs = this.deps.db.listJobsByStatus(["queued"]);
    const idleWorkers = this.deps.db.listWorkers().filter((worker) => worker.status === "idle");

    for (const worker of idleWorkers) {
      const job = queuedJobs.shift();
      if (!job) {
        break;
      }

      void this.runJob(worker.id, job);
    }
  }

  private async runJob(workerId: string, job: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.workerAbortControllers.set(workerId, controller);

    let attempt: AttemptRecord | null = null;
    let task: Task | null = null;
    let repo: RepoRef | null = null;
    let worktreePath: string | null = null;
    let beforeSha: string | null = null;
    let currentPrUrl: string | null = null;

    try {
      task = await this.deps.taskSystem.getTask(job.taskId);
      repo = assertTaskActionableRepo(task, this.deps.repos);
      const leaseExpiresAt = addSeconds(new Date(), this.deps.config.scheduler.leaseTtlSeconds);

      for (const lease of leaseResourceKeysForAction(task, job.action)) {
        const acquired = this.deps.db.acquireLease({
          resourceType: lease.resourceType,
          resourceKey: lease.resourceKey,
          workerId,
          expiresAt: leaseExpiresAt,
        });
        if (!acquired) {
          return;
        }
      }

      this.deps.db.updateWorkerStatus(workerId, "leased", null);
      this.deps.db.updateJobStatus(job.id, "leased", { leasedAt: isoNow() });
      attempt = this.deps.db.createAttempt({
        jobId: job.id,
        workerId,
        runnerModel: this.deps.config.runner.model,
        runnerVariant: this.deps.config.runner.variant,
      });
      this.deps.db.updateWorkerStatus(workerId, "running", attempt.id);
      this.deps.db.updateJobStatus(job.id, "running", { startedAt: attempt.startedAt });
      this.deps.db.addAttemptEvent(attempt.id, "attempt_started", `Started ${job.action} for ${task.id}`);
      this.emit("worker_updated", { workerId, status: "running", attemptId: attempt.id });
      this.emit("attempt_changed", { attemptId: attempt.id, status: "running" });

      const heartbeat = setInterval(() => {
        this.deps.db.heartbeatWorker(workerId, attempt?.id ?? null, addSeconds(new Date(), this.deps.config.scheduler.leaseTtlSeconds));
      }, this.deps.config.scheduler.workerHeartbeatSeconds * 1000);

      try {
        if (job.action === "execution" || job.action === "retry") {
          await this.deps.taskSystem.transition({ taskId: task.id, toState: "in_progress" });
        }

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

        if (await pathExists(worktreePath)) {
          beforeSha = await this.gitHead(worktreePath).catch(() => null);
        } else {
          worktreePath = repo.rootPath;
          beforeSha = await this.gitHead(worktreePath).catch(() => null);
        }

        const comments = await this.deps.taskSystem.listComments(task.id);
        const reviewContext =
          job.action === "review" || job.action === "retry"
            ? (await this.deps.reviewService.getContext(task, this.deps.config.workspace.agentPrefix)) ?? undefined
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

        const promptRelativePath = path.join("artifacts", `attempt-${attempt.id}-prompt.md`);
        const promptAbsolutePath = path.join(this.deps.paths.workspaceRoot, promptRelativePath);
        await atomicWriteFile(promptAbsolutePath, prompt);
        const promptStat = await fs.stat(promptAbsolutePath);
        this.deps.db.createArtifact({
          ownerType: "execution_attempt",
          ownerId: attempt.id,
          artifactType: "rendered_prompt",
          relativePath: promptRelativePath,
          mediaType: "text/markdown",
          sizeBytes: promptStat.size,
          sha256: await sha256File(promptAbsolutePath),
        });

        const runResult = await this.deps.runner.invoke({
          attemptId: attempt.id,
          cwd: worktreePath,
          env: this.deps.env,
          prompt,
          timeoutMs: this.deps.config.runner.timeoutMs,
          abortSignal: controller.signal,
        } as Parameters<OpenCodeRunner["invoke"]>[0]) as CapturedAgentRunResult;

        const logRelativePath = path.join("logs", "attempts", `${attempt.id}.log`);
        const logAbsolutePath = path.join(this.deps.paths.workspaceRoot, logRelativePath);
        await ensureDir(path.dirname(logAbsolutePath));
        await atomicWriteFile(logAbsolutePath, `${runResult.stdout}${runResult.stderr ? `\n[stderr]\n${runResult.stderr}` : ""}`);
        const logStat = await fs.stat(logAbsolutePath);
        this.deps.db.createArtifact({
          ownerType: "execution_attempt",
          ownerId: attempt.id,
          artifactType: "log",
          relativePath: logRelativePath,
          mediaType: "text/plain",
          sizeBytes: logStat.size,
          sha256: await sha256File(logAbsolutePath),
        });

        let workerResult: WorkerResult;
        try {
          workerResult = validateWorkerResult(parseWorkerResult(runResult.stdout));
        } catch (error) {
          throw new ForemanError("worker_result_invalid", error instanceof Error ? error.message : String(error), 500);
        }

        const resultRelativePath = path.join("artifacts", `attempt-${attempt.id}-result.json`);
        const resultAbsolutePath = path.join(this.deps.paths.workspaceRoot, resultRelativePath);
        await atomicWriteFile(resultAbsolutePath, `${JSON.stringify(workerResult, null, 2)}\n`);
        const resultStat = await fs.stat(resultAbsolutePath);
        this.deps.db.createArtifact({
          ownerType: "execution_attempt",
          ownerId: attempt.id,
          artifactType: "parsed_result",
          relativePath: resultRelativePath,
          mediaType: "application/json",
          sizeBytes: resultStat.size,
          sha256: await sha256File(resultAbsolutePath),
        });
        this.deps.db.addAttemptEvent(attempt.id, "worker_result_parsed", workerResult.summary, { outcome: workerResult.outcome });

        currentPrUrl = await this.applyWorkerResult({
          attempt,
          job,
          task,
          repo,
          worktreePath,
          workerResult,
        });

        const attemptStatus = deriveAttemptStatus(workerResult);
        const jobStatus = attemptStatus === "timed_out" ? "failed" : attemptStatus;
        const afterSha = await this.gitHead(worktreePath).catch(() => null);
        this.deps.db.finalizeAttempt(attempt.id, attemptStatus, {
          finishedAt: runResult.finishedAt,
          exitCode: runResult.exitCode,
          signal: runResult.signal,
          summary: workerResult.summary,
          errorMessage: workerResult.outcome === "failed" ? workerResult.summary : null,
        });
        this.deps.db.updateJobStatus(job.id, jobStatus, {
          finishedAt: runResult.finishedAt,
          errorMessage: workerResult.outcome === "failed" ? workerResult.summary : null,
        });
        const historyInput: Parameters<ForemanDb["addHistoryStep"]>[0] = {
          createdAt: runResult.finishedAt,
          stage: job.action,
          issue: task.id.toLowerCase(),
          summary: workerResult.summary,
        };
        if (beforeSha && afterSha) {
          historyInput.repos = [{ path: repo.rootPath, beforeSha, afterSha }];
        }
        this.deps.db.addHistoryStep(historyInput);

        if (job.action === "consolidation" && workerResult.outcome === "completed" && worktreePath !== repo.rootPath) {
          await removeCleanWorktree(repo, worktreePath);
        }
      } finally {
        clearInterval(heartbeat);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt) {
        this.deps.db.addAttemptEvent(attempt.id, "attempt_failed", message);
        this.deps.db.finalizeAttempt(attempt.id, controller.signal.aborted ? "canceled" : "failed", {
          finishedAt: isoNow(),
          summary: message,
          errorMessage: message,
        });
        this.emit("attempt_changed", { attemptId: attempt.id, status: controller.signal.aborted ? "canceled" : "failed" });
      }
      this.deps.db.updateJobStatus(job.id, controller.signal.aborted ? "canceled" : "failed", {
        finishedAt: isoNow(),
        errorMessage: message,
      });
    } finally {
      if (attempt) {
        this.deps.db.releaseLeasesForAttempt(attempt.id, controller.signal.aborted ? "stopped" : "completed");
      } else if (task) {
        for (const lease of leaseResourceKeysForAction(task, job.action)) {
          this.deps.db.releaseLeaseByResource(lease.resourceType, lease.resourceKey, "skipped");
        }
      }

      this.deps.db.updateWorkerStatus(workerId, "idle", null);
      this.emit("worker_updated", { workerId, status: "idle" });
      this.workerAbortControllers.delete(workerId);
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
    let pullRequestUrl = input.task.artifacts.find((artifact) => artifact.type === "pull_request")?.url ?? null;

    if (workerResult.outcome === "blocked") {
      for (const blocker of workerResult.blockers) {
        await this.deps.taskSystem.addComment({
          taskId: input.task.id,
          body: `${this.deps.config.workspace.agentPrefix}${blocker.code}: ${blocker.message}`,
        });
      }
      return pullRequestUrl;
    }

    if (workerResult.outcome === "failed") {
      return pullRequestUrl;
    }

    const createOrReopen = workerResult.reviewMutations.filter(
      (mutation) => mutation.type === "create_pull_request" || mutation.type === "reopen_pull_request",
    );

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
        await this.deps.reviewService.replyToReviewSummary(pullRequestUrl, mutation.reviewId, mutation.body);
      }
      if (mutation.type === "reply_to_pr_comment") {
        await this.deps.reviewService.replyToPrComment(pullRequestUrl, mutation.commentId, mutation.body);
      }
      if (mutation.type === "resolve_threads") {
        await this.deps.reviewService.resolveThreads(pullRequestUrl, mutation.threadIds);
      }
    }

    for (const mutation of workerResult.taskMutations) {
      if (mutation.type === "add_comment") {
        await this.deps.taskSystem.addComment({ taskId: input.task.id, body: mutation.body });
      }
      if (mutation.type === "upsert_artifact") {
        await this.deps.taskSystem.addArtifact({ taskId: input.task.id, artifact: mutation.artifact });
      }
    }

    for (const mutation of workerResult.learningMutations) {
      if (mutation.type === "add") {
        this.deps.db.addLearning(mutation);
      }
      if (mutation.type === "update") {
        this.deps.db.updateLearning(mutation);
      }
    }

    if (
      input.job.action === "review" &&
      workerResult.outcome === "no_action_needed" &&
      workerResult.signals.includes("review_checkpoint_eligible") &&
      pullRequestUrl
    ) {
      const reviewContext = await this.deps.reviewService.getContext(input.task, this.deps.config.workspace.agentPrefix);
      if (reviewContext) {
        this.deps.db.upsertReviewCheckpoint({
          taskId: input.task.id,
          prUrl: pullRequestUrl,
          reviewContext,
          sourceAttemptId: input.attempt.id,
        });
      }
    }

    this.scheduleScout("task_mutation");
    return pullRequestUrl;
  }

  private async gitHead(cwd: string): Promise<string> {
    const { exec } = await import("./lib/process.js");
    return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  }
}
