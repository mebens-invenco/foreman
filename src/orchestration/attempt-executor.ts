import { promises as fs } from "node:fs";
import path from "node:path";

import { deriveAttemptStatus, type RepoRef, type ReviewContext, type Task, type TaskState, type TaskTarget, type WorkerResult } from "../domain/index.js";
import { createAgentRunner, parseWorkerResult, validateWorkerResult, type AgentRunner, type CapturedAgentRunResult, type WorkerResultAction } from "../execution/index.js";
import { parseWorkerPromptPullRequestReference, renderWorkerPrompt, renderWorkerResultRecoveryPrompt } from "../execution/render-worker-prompt.js";
import { ForemanError, isForemanError } from "../lib/errors.js";
import { atomicWriteFile, ensureDir, pathExists, sha256File } from "../lib/fs.js";
import { addSeconds, isoNow } from "../lib/time.js";
import type { LoggerService } from "../logger.js";
import type { AttemptRecord, ForemanRepos, JobRecord, RunnerSessionRecord, WorkerRecord } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import { runnerForAction, runnerSessionRoleForAction, runnerTuningValue, type WorkspaceConfig, type WorkspaceRunnerConfig } from "../workspace/config.js";
import { ensureTaskWorktree, removeCleanWorktree } from "../workspace/git-worktrees.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";
import { assertTaskActionableTarget, leaseResourceKeysForAction } from "./scout-selection.js";

const runnerOutputLimit = 4_000;
const workerResultRecoveryTimeoutMs = 120_000;

const truncateRunnerOutput = (output: string): string =>
  output.length > runnerOutputLimit ? `${output.slice(0, runnerOutputLimit)}\n... truncated ...` : output;

const formatRunnerFailure = (runResult: {
  exitCode: number | null;
  signal: string | null;
  timedOut?: boolean;
  timeoutMs?: number | null;
  stdout: string;
  stderr: string;
}): string => {
  const status = runResult.timedOut
    ? `timed out${runResult.timeoutMs ? ` after ${runResult.timeoutMs}ms` : ""}${runResult.signal ? ` with signal ${runResult.signal}` : ""}`
    : runResult.signal
      ? `signal ${runResult.signal}`
      : runResult.exitCode === null
        ? "without an exit code"
        : `exit code ${runResult.exitCode}`;
  const details = [`Runner exited with ${status}`];
  const stderr = runResult.stderr.trim();
  const stdout = runResult.stdout.trim();

  if (stderr) {
    details.push(`stderr:\n${truncateRunnerOutput(stderr)}`);
  }
  if (stdout) {
    details.push(`stdout:\n${truncateRunnerOutput(stdout)}`);
  }
  if (!stderr && !stdout) {
    details.push("No runner output was captured.");
  }

  return details.join("\n");
};

const formatWorkerResultParseFailure = (input: {
  parseError: unknown;
  stdoutArtifactPath?: string;
  recoveryError?: unknown;
  recoveryStdoutArtifactPath?: string;
}): string => {
  const parseMessage = input.parseError instanceof Error ? input.parseError.message : String(input.parseError);
  const details = [`Worker output did not contain a valid result block: ${parseMessage}`];

  if (input.stdoutArtifactPath) {
    details.push(`Invalid runner stdout was saved to ${input.stdoutArtifactPath}.`);
  }
  if (input.recoveryError) {
    details.push(`Result recovery also failed: ${input.recoveryError instanceof Error ? input.recoveryError.message : String(input.recoveryError)}`);
  }
  if (input.recoveryStdoutArtifactPath) {
    details.push(`Recovery stdout was saved to ${input.recoveryStdoutArtifactPath}.`);
  }

  return details.join("\n");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readReviewContext = (selectionContext: Record<string, unknown>): ReviewContext | undefined => {
  const raw = selectionContext.reviewContext;
  return isRecord(raw) && raw.provider === "github" ? (raw as ReviewContext) : undefined;
};

const readDeploymentInstructionBody = (selectionContext: Record<string, unknown>): string | undefined => {
  const raw = selectionContext.deployment;
  return isRecord(raw) && typeof raw.instructionBody === "string" ? raw.instructionBody : undefined;
};

type AttemptExecutorDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  repos: RepoRef[];
  env: Record<string, string>;
  logger: LoggerService;
    applyWorkerResult: (input: {
      attempt: AttemptRecord;
      job: JobRecord;
      task: Task;
      target: TaskTarget;
      repo: RepoRef;
      worktreePath: string;
      reviewContext?: ReviewContext;
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
    let taskStateBeforeExecution: TaskState | null = null;
    let transitionedTaskToInProgress = false;

    try {
      if (job.jobKind === "cron" || job.action === "cron" || !job.taskId || !job.taskTargetId) {
        throw new ForemanError("invalid_task_job", `Job ${job.id} is not a task job.`, 500);
      }
      const taskTargetId = job.taskTargetId;

      task = await this.deps.taskSystem.getTask(job.taskId);
      const mirroredTask = this.deps.foremanRepos.taskMirror.getTask(job.taskId);
      if (mirroredTask && mirroredTask.pullRequests.length > 0) {
        task = { ...task, pullRequests: mirroredTask.pullRequests };
      }
      const persistedTarget = this.deps.foremanRepos.taskMirror.getTaskTargetById(taskTargetId);
      if (!persistedTarget) {
        throw new ForemanError("task_missing_target", `Job ${job.id} references missing task target ${taskTargetId}.`);
      }

      const actionableTarget = assertTaskActionableTarget(task, this.deps.repos, persistedTarget);
      const target: TaskTarget = actionableTarget.target;
      repo = actionableTarget.repo;
      const runnerConfig = runnerForAction(this.deps.config, job.action);
      const runnerSessionSelector = {
        taskTargetId,
        role: runnerSessionRoleForAction(job.action),
        runnerName: runnerConfig.type,
        runnerModel: runnerConfig.model,
        runnerVariant: runnerTuningValue(runnerConfig),
      };
      taskStateBeforeExecution = task.state;
      jobLogger = jobLogger.child({ taskState: task.state, repo: repo.key });
      jobLogger.info("loaded task and resolved repo", { baseBranch: job.baseBranch ?? repo.defaultBranch });
      const leaseExpiresAt = addSeconds(new Date(), this.deps.config.scheduler.leaseTtlSeconds);
      const runner = createAgentRunner({ config: this.deps.config, action: job.action });

      attempt = this.deps.foremanRepos.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId,
        runnerName: runnerConfig.type,
        runnerModel: runnerConfig.model,
        runnerVariant: runnerTuningValue(runnerConfig),
        expiresAt: leaseExpiresAt,
        leases: leaseResourceKeysForAction(task, job.action, target),
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
                taskTarget: target,
                baseBranch: job.baseBranch ?? repo.defaultBranch,
                action: job.action,
              });
        attemptLogger.info("prepared worktree", {
          worktreePath,
          mode: job.action === "consolidation" ? "consolidation" : "task_worktree",
        });

        if (job.action === "execution" || job.action === "retry") {
          await this.deps.taskSystem.transition({ taskId: task.id, toState: "in_progress" });
          transitionedTaskToInProgress = true;
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

        const selectionContext = job.selectionContext ?? {};
        const pullRequestReference = parseWorkerPromptPullRequestReference(selectionContext.pullRequestReference);
        const reviewContext = readReviewContext(selectionContext);
        const deploymentInstructionBody = readDeploymentInstructionBody(selectionContext);
        const reviewHeadSha = pullRequestReference?.headSha ?? reviewContext?.headSha ?? null;
        const usesRunnerSession = job.action !== "consolidation";
        const activeRunnerSession =
          usesRunnerSession && job.action !== "retry"
            ? this.deps.foremanRepos.runnerSessions.getActiveSession(runnerSessionSelector)
            : null;
        const runnerSession = usesRunnerSession
          ? (activeRunnerSession ?? this.deps.foremanRepos.runnerSessions.createSession({ ...runnerSessionSelector, isActive: false }))
          : null;
        if (runnerSession) {
          this.deps.foremanRepos.attempts.linkRunnerSession(attempt.id, runnerSession.id);
          this.deps.foremanRepos.runnerSessions.updateSession(runnerSession.id, {
            lastAttemptId: attempt.id,
            lastReviewHeadSha: reviewHeadSha,
          });
        }
        const isContinuation = Boolean(activeRunnerSession?.nativeSessionId);
        attemptLogger.info("resolved runner session", {
          runnerSessionId: runnerSession?.id ?? null,
          nativeSessionId: activeRunnerSession?.nativeSessionId ?? null,
          continuation: isContinuation,
        });

        const prompt = await renderWorkerPrompt({
          action: job.action,
          config: this.deps.config,
          paths: this.deps.paths,
          task,
          repo,
          taskTarget: target,
          worktreePath,
          baseBranch: job.baseBranch ?? repo.defaultBranch,
          gitState: {
            worktreeHeadSha: beforeSha,
            reviewHeadSha,
            baseBranch: job.baseBranch ?? repo.defaultBranch,
            previousSessionHeadSha: activeRunnerSession?.lastWorktreeHeadSha ?? null,
          },
          continuation: isContinuation,
          ...(pullRequestReference ? { pullRequestReference } : {}),
          ...(deploymentInstructionBody !== undefined ? { deploymentInstructionBody } : {}),
        });
        attemptLogger.info("rendered worker prompt", { hasPullRequestReference: Boolean(pullRequestReference) });

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

        const runResult = await runner.invoke({
          attemptId: attempt.id,
          action: job.action,
          cwd: worktreePath,
          env: this.deps.env,
          prompt,
          timeoutMs: runnerConfig.timeoutMs,
          ...(activeRunnerSession?.nativeSessionId ? { nativeSessionId: activeRunnerSession.nativeSessionId } : {}),
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
          timedOut: runResult.timedOut === true,
          timeoutMs: runResult.timeoutMs ?? null,
          nativeSessionId: runResult.nativeSessionId ?? null,
          stdoutBytes: runResult.stdoutBytes,
          stderrBytes: runResult.stderrBytes,
        });
        if (runnerSession) {
          this.deps.foremanRepos.runnerSessions.updateSession(runnerSession.id, {
            nativeSessionId: runResult.nativeSessionId ?? null,
            lastAttemptId: attempt.id,
            lastReviewHeadSha: reviewHeadSha,
          });
        }

        const runnerOutputRelativePath = await this.writeRunnerOutputArtifact(attempt.id, runResult.stdout, "runner-output");
        this.deps.foremanRepos.attempts.addAttemptEvent(attempt.id, "runner_output_recorded", "Recorded normalized runner stdout", {
          artifactPath: runnerOutputRelativePath,
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

        const { workerResult, finalRunResult } = await this.parseOrRecoverWorkerResult({
          runner,
          runnerConfig,
          attempt,
          attemptLogger,
          job,
          task,
          worktreePath,
          runResult,
          runnerOutputRelativePath,
          runnerSession,
          activeRunnerSession,
          reviewHeadSha,
          abortSignal: controller.signal,
        });
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
          target,
          repo,
          worktreePath,
          ...(reviewContext ? { reviewContext } : {}),
          workerResult,
        });
        attemptLogger.info("applied worker result", { currentPrUrl });

        const attemptStatus = deriveAttemptStatus(workerResult);
        const jobStatus = attemptStatus === "timed_out" ? "failed" : attemptStatus;
        const afterSha = await this.gitHead(worktreePath).catch(() => null);
        if (runnerSession) {
          this.deps.foremanRepos.runnerSessions.updateSession(runnerSession.id, {
            lastAttemptId: attempt.id,
            lastWorktreeHeadSha: afterSha,
            lastReviewHeadSha: reviewHeadSha,
            ...(attemptStatus === "completed" ? { isActive: true } : {}),
          });
        }
        if (job.action === "retry" && attemptStatus === "completed") {
          const reviewerRunnerConfig = runnerForAction(this.deps.config, "reviewer");
          const activeReviewerSession = this.deps.foremanRepos.runnerSessions.getActiveSession({
            taskTargetId,
            role: "reviewer",
            runnerName: reviewerRunnerConfig.type,
            runnerModel: reviewerRunnerConfig.model,
            runnerVariant: runnerTuningValue(reviewerRunnerConfig),
          });
          if (activeReviewerSession) {
            this.deps.foremanRepos.runnerSessions.updateSession(activeReviewerSession.id, { isActive: false });
            attemptLogger.info("deactivated reviewer session after completed retry", {
              reviewerRunnerSessionId: activeReviewerSession.id,
            });
          }
        }
        this.deps.foremanRepos.attempts.finalizeAttempt(attempt.id, attemptStatus, {
          finishedAt: finalRunResult.finishedAt,
          exitCode: finalRunResult.exitCode,
          signal: finalRunResult.signal,
          summary: workerResult.summary,
          errorMessage: workerResult.outcome === "failed" ? workerResult.summary : null,
        });
        this.deps.foremanRepos.jobs.updateJobStatus(job.id, jobStatus, {
          finishedAt: finalRunResult.finishedAt,
          errorMessage: workerResult.outcome === "failed" ? workerResult.summary : null,
        });
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
      const attemptStatus = controller.signal.aborted
        ? "canceled"
        : isForemanError(error) && error.code === "runner_timed_out"
          ? "timed_out"
          : "failed";
      const jobStatus = attemptStatus === "timed_out" ? "failed" : attemptStatus;
      if (attempt) {
        const attemptLogger = jobLogger.child({ attemptId: attempt.id });
        attemptLogger.error("attempt failed", { error: message, aborted: controller.signal.aborted });
        if (task && transitionedTaskToInProgress && taskStateBeforeExecution && taskStateBeforeExecution !== "in_progress") {
          try {
            await this.deps.taskSystem.transition({ taskId: task.id, toState: taskStateBeforeExecution });
            attemptLogger.info("restored task state after failed attempt", { restoredState: taskStateBeforeExecution });
          } catch (restoreError) {
            attemptLogger.warn("failed to restore task state after failed attempt", {
              restoreState: taskStateBeforeExecution,
              error: restoreError instanceof Error ? restoreError.message : String(restoreError),
            });
          }
        }
        this.deps.foremanRepos.attempts.addAttemptEvent(attempt.id, "attempt_failed", message);
        this.deps.foremanRepos.attempts.finalizeAttempt(attempt.id, attemptStatus, {
          finishedAt: isoNow(),
          summary: message,
          errorMessage: message,
        });
        this.deps.onAttemptChanged({ attemptId: attempt.id, status: attemptStatus });
      }
      this.deps.foremanRepos.jobs.updateJobStatus(job.id, jobStatus, {
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

  private async parseOrRecoverWorkerResult(input: {
    runner: AgentRunner;
    runnerConfig: WorkspaceRunnerConfig;
    attempt: AttemptRecord;
    attemptLogger: LoggerService;
    job: JobRecord;
    task: Task;
    worktreePath: string;
    runResult: CapturedAgentRunResult;
    runnerOutputRelativePath: string;
    runnerSession: RunnerSessionRecord | null;
    activeRunnerSession: RunnerSessionRecord | null;
    reviewHeadSha: string | null;
    abortSignal: AbortSignal;
  }): Promise<{ workerResult: WorkerResult; finalRunResult: CapturedAgentRunResult }> {
    try {
      return {
        workerResult: validateWorkerResult(parseWorkerResult(input.runResult.stdout)),
        finalRunResult: input.runResult,
      };
    } catch (parseError) {
      const canRecoverTimedOutOutput =
        input.runResult.timedOut === true && !input.abortSignal.aborted && input.runResult.stdout.trim().length > 0;
      if ((input.runResult.exitCode !== 0 || input.runResult.signal) && !canRecoverTimedOutOutput) {
        throw new ForemanError(
          input.runResult.timedOut === true && !input.abortSignal.aborted ? "runner_timed_out" : "runner_failed",
          formatRunnerFailure(input.runResult),
          500,
        );
      }

      input.attemptLogger.warn(
        input.runResult.timedOut
          ? "worker result parsing failed after runner timeout; requesting recovery"
          : "worker result parsing failed after successful runner exit; requesting recovery",
        {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          runnerOutputPath: input.runnerOutputRelativePath,
          timedOut: input.runResult.timedOut === true,
        },
      );
      this.deps.foremanRepos.attempts.addAttemptEvent(input.attempt.id, "worker_result_recovery_started", "Requesting recovered worker result", {
        parseError: parseError instanceof Error ? parseError.message : String(parseError),
        runnerOutputPath: input.runnerOutputRelativePath,
        timedOut: input.runResult.timedOut === true,
      });

      return this.recoverWorkerResult({ ...input, parseError });
    }
  }

  private async recoverWorkerResult(input: {
    runner: AgentRunner;
    runnerConfig: WorkspaceRunnerConfig;
    attempt: AttemptRecord;
    attemptLogger: LoggerService;
    job: JobRecord;
    task: Task;
    worktreePath: string;
    runResult: CapturedAgentRunResult;
    runnerOutputRelativePath: string;
    runnerSession: RunnerSessionRecord | null;
    activeRunnerSession: RunnerSessionRecord | null;
    reviewHeadSha: string | null;
    abortSignal: AbortSignal;
    parseError: unknown;
  }): Promise<{ workerResult: WorkerResult; finalRunResult: CapturedAgentRunResult }> {
    const recoveryNativeSessionId = input.runResult.nativeSessionId ?? input.activeRunnerSession?.nativeSessionId;
    const recoveryResult = await input.runner.invoke({
      attemptId: input.attempt.id,
      action: input.job.action,
      cwd: input.worktreePath,
      env: this.deps.env,
      prompt: await renderWorkerResultRecoveryPrompt({
        action: input.job.action as WorkerResultAction,
        paths: this.deps.paths,
        task: input.task,
        parseError: input.parseError,
        stdoutArtifactPath: input.runnerOutputRelativePath,
        invalidStdout: input.runResult.stdout,
      }),
      timeoutMs: Math.min(input.runnerConfig.timeoutMs, workerResultRecoveryTimeoutMs),
      ...(recoveryNativeSessionId ? { nativeSessionId: recoveryNativeSessionId } : {}),
      abortSignal: input.abortSignal,
      onStdoutLine: (line: string) => {
        input.attemptLogger.runnerLine(line);
      },
      onStderrLine: (line: string) => {
        input.attemptLogger.runnerLine(line);
      },
    });
    input.attemptLogger.info("worker result recovery invocation completed", {
      exitCode: recoveryResult.exitCode,
      signal: recoveryResult.signal,
      timedOut: recoveryResult.timedOut === true,
      timeoutMs: recoveryResult.timeoutMs ?? null,
      nativeSessionId: recoveryResult.nativeSessionId ?? null,
      stdoutBytes: recoveryResult.stdoutBytes,
      stderrBytes: recoveryResult.stderrBytes,
    });
    if (input.runnerSession) {
      this.deps.foremanRepos.runnerSessions.updateSession(input.runnerSession.id, {
        nativeSessionId: recoveryResult.nativeSessionId ?? input.runResult.nativeSessionId ?? null,
        lastAttemptId: input.attempt.id,
        lastReviewHeadSha: input.reviewHeadSha,
      });
    }
    const recoveryOutputRelativePath = await this.writeRunnerOutputArtifact(input.attempt.id, recoveryResult.stdout, "runner-recovery-output");

    try {
      if (recoveryResult.exitCode !== 0 || recoveryResult.signal) {
        throw new Error(formatRunnerFailure(recoveryResult));
      }

      const workerResult = validateWorkerResult(parseWorkerResult(recoveryResult.stdout));
      this.deps.foremanRepos.attempts.addAttemptEvent(input.attempt.id, "worker_result_recovered", workerResult.summary, {
        recoveryOutputPath: recoveryOutputRelativePath,
      });

      return { workerResult, finalRunResult: recoveryResult };
    } catch (recoveryError) {
      throw new ForemanError(
        "worker_result_invalid",
        formatWorkerResultParseFailure({
          parseError: input.parseError,
          stdoutArtifactPath: input.runnerOutputRelativePath,
          recoveryError,
          recoveryStdoutArtifactPath: recoveryOutputRelativePath,
        }),
        500,
      );
    }
  }

  private async writeRunnerOutputArtifact(attemptId: string, stdout: string, name: string): Promise<string> {
    const relativePath = path.join("artifacts", `attempt-${attemptId}-${name}.txt`);
    const absolutePath = path.join(this.deps.paths.workspaceRoot, relativePath);
    await atomicWriteFile(absolutePath, stdout);
    const stat = await fs.stat(absolutePath);
    this.deps.foremanRepos.artifacts.createArtifact({
      ownerType: "execution_attempt",
      ownerId: attemptId,
      artifactType: "runner_output",
      relativePath,
      mediaType: "text/plain",
      sizeBytes: stat.size,
      sha256: await sha256File(absolutePath),
    });

    return relativePath;
  }
}
