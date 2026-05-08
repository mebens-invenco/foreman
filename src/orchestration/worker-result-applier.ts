import type { RepoRef, ReviewContext, ReviewMutation, Task, TaskPullRequest, TaskTarget, WorkerResult } from "../domain/index.js";
import { ForemanError } from "../lib/errors.js";
import { addSeconds } from "../lib/time.js";
import type { LoggerService } from "../logger.js";
import type { DeploymentStatus } from "../repos/deployment-tracking-repo.js";
import type { AttemptRecord, ForemanRepos, JobRecord } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";

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

const ensureReviewCommentPrefix = (body: string, prefix: string): string =>
  body.startsWith(prefix) ? body : `${prefix}${body}`;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const deploymentRetryIntervalMinutes = (input: {
  retryCount: number;
  minRetryIntervalMinutes: number;
  maxRetryIntervalMinutes: number;
}): number => {
  const multiplier = 2 ** Math.max(0, input.retryCount - 1);
  return Math.min(input.maxRetryIntervalMinutes, input.minRetryIntervalMinutes * multiplier);
};

type WorkerResultApplierDeps = {
  config: WorkspaceConfig;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  repos: RepoRef[];
  logger: LoggerService;
  scheduleScout: () => void;
};

type ApplyWorkerResultInput = {
  attempt: AttemptRecord;
  job: JobRecord;
  task: Task;
  target: TaskTarget;
  repo: RepoRef;
  worktreePath: string;
  reviewContext?: ReviewContext;
  workerResult: WorkerResult;
};

export class WorkerResultApplier {
  private readonly logger: LoggerService;

  constructor(private readonly deps: WorkerResultApplierDeps) {
    this.logger = deps.logger.child({ component: "worker-result-applier" });
  }

  async apply(input: ApplyWorkerResultInput): Promise<string | null> {
    const { workerResult } = input;
    let pullRequestUrl = await this.resolveCurrentPullRequestUrl(input.task, input.repo, input.target);
    const logger = this.logger.child({
      attemptId: input.attempt.id,
      jobId: input.job.id,
      taskId: input.task.id,
      action: input.job.action,
      outcome: workerResult.outcome,
    });
    logger.info("applying worker result mutations");

    if (input.job.action === "deployment") {
      return this.applyDeploymentResult(input, pullRequestUrl, logger);
    }

    if (workerResult.outcome === "blocked") {
      for (const blocker of workerResult.blockers) {
        await this.deps.taskSystem.addComment({
          taskId: input.task.id,
          body: `${this.deps.config.workspace.agentPrefix}${blocker}`,
        });
        logger.warn("posted blocker comment", { blocker });
      }
      if (input.job.action === "review" && pullRequestUrl) {
        await this.applyReviewMutations(workerResult.reviewMutations, pullRequestUrl, logger);
        await this.saveReviewCheckpoint(input, pullRequestUrl, logger);
      }
      return pullRequestUrl;
    }

    if (workerResult.outcome === "failed") {
      logger.warn("worker result marked attempt as failed; skipping side effects");
      return pullRequestUrl;
    }

    const createPullRequests = workerResult.reviewMutations.filter((mutation) => mutation.type === "create_pull_request");
    const requiresPullRequest =
      (input.job.action === "execution" || input.job.action === "retry") &&
      workerResult.outcome === "completed" &&
      workerResult.signals.includes("code_changed");

    for (const mutation of createPullRequests) {
      const created = await this.deps.reviewService.createPullRequest({
        cwd: input.worktreePath,
        title: mutation.title,
        body: mutation.body,
        draft: mutation.draft,
        baseBranch: mutation.baseBranch,
        headBranch: mutation.headBranch,
      });
      pullRequestUrl = created.url;
      await this.recordPullRequest(input.task.id, {
        repoKey: input.target.repoKey,
        url: created.url,
        title: mutation.title,
        source: "local",
      }, logger);
      await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "in_review" });
      logger.info("created pull request", { pullRequestUrl: created.url, pullRequestNumber: created.number });
    }

    if (requiresPullRequest && createPullRequests.length === 0) {
      if (!pullRequestUrl) {
        throw new ForemanError(
          "missing_pull_request",
          "Execution results with code changes must include a create_pull_request mutation",
        );
      }

      await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "in_review" });
      logger.info("transitioned task to in_review using existing pull request artifact", { pullRequestUrl });
    }

    if (input.job.action === "execution" && workerResult.outcome === "no_action_needed") {
      const resolvedPullRequest = await this.deps.reviewService.resolvePullRequest(input.task, input.repo, input.target);
      if (resolvedPullRequest?.state === "open") {
        pullRequestUrl = resolvedPullRequest.pullRequestUrl;
        await this.recordPullRequest(input.task.id, {
          repoKey: input.target.repoKey,
          url: resolvedPullRequest.pullRequestUrl,
          source: "branch_inferred",
        }, logger);
        await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "in_review" });
        logger.info("transitioned task to in_review after execution no-op on open pull request", { pullRequestUrl });
      }
    }

    await this.applyReviewMutations(workerResult.reviewMutations, pullRequestUrl, logger);

    for (const mutation of workerResult.taskMutations) {
      if (mutation.type === "add_comment") {
        await this.deps.taskSystem.addComment({ taskId: input.task.id, body: mutation.body });
        logger.info("added task comment from worker mutation");
      }
      if (mutation.type === "create_task") {
        const createdTask = await this.deps.taskSystem.createTask({ parentTask: input.task, mutation });
        this.deps.foremanRepos.attempts.addAttemptEvent(
          input.attempt.id,
          "task_created",
          `Created task ${createdTask.id}`,
          { taskId: createdTask.id, providerId: createdTask.providerId, url: createdTask.url },
        );
        logger.info("created task from worker mutation", {
          createdTaskId: createdTask.id,
          createdProviderId: createdTask.providerId,
          url: createdTask.url,
        });
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
      pullRequestUrl
    ) {
      await this.saveReviewCheckpoint(input, pullRequestUrl, logger);
    }

    if (
      input.job.action === "reviewer" &&
      workerResult.outcome === "no_action_needed" &&
      pullRequestUrl
    ) {
      const reviewContext =
        input.reviewContext ??
        (await this.deps.reviewService.getContext(
          input.task,
          this.deps.config.workspace.agentPrefix,
          input.repo,
          input.target,
        ));
      if (reviewContext) {
        try {
          this.deps.foremanRepos.reviewerCheckpoints.upsertReviewerCheckpoint({
            taskId: input.task.id,
            taskTargetId: input.target.id,
            prUrl: pullRequestUrl,
            reviewContext,
            sourceAttemptId: input.attempt.id,
          });
          logger.info("saved reviewer checkpoint", { pullRequestUrl });
        } catch (error) {
          this.deps.foremanRepos.attempts.addAttemptEvent(
            input.attempt.id,
            "reviewer_checkpoint_warning",
            error instanceof Error ? error.message : String(error),
          );
          logger.warn("failed to save reviewer checkpoint", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    this.deps.scheduleScout();
    logger.info("scheduled follow-up scout after task mutations", { pullRequestUrl });
    return pullRequestUrl;
  }

  private async resolveCurrentPullRequestUrl(task: Task, repo: RepoRef, target: TaskTarget): Promise<string | null> {
    const resolvedPullRequest = await this.deps.reviewService.resolvePullRequest(task, repo, target);
    return resolvedPullRequest?.pullRequestUrl ?? null;
  }

  private async applyReviewMutations(mutations: ReviewMutation[], pullRequestUrl: string | null, logger: LoggerService): Promise<void> {
    for (const mutation of mutations) {
      if (mutation.type === "create_pull_request") {
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
      if (mutation.type === "submit_pull_request_review") {
        await this.deps.reviewService.submitPullRequestReview(pullRequestUrl, {
          body: ensureReviewCommentPrefix(mutation.body, this.deps.config.reviewer.agentPrefix),
          event: mutation.event,
          comments: mutation.comments.map((comment) => ({
            ...comment,
            body: ensureReviewCommentPrefix(comment.body, this.deps.config.reviewer.agentPrefix),
          })),
        });
        logger.info("submitted pull request review", { commentCount: mutation.comments.length, event: mutation.event });
      }
      if (mutation.type === "resolve_threads") {
        await this.deps.reviewService.resolveThreads(pullRequestUrl, mutation.threadIds);
        logger.info("resolved review threads", { threadCount: mutation.threadIds.length });
      }
    }
  }

  private async applyDeploymentResult(input: ApplyWorkerResultInput, pullRequestUrl: string | null, logger: LoggerService): Promise<string | null> {
    const { workerResult } = input;
    if (workerResult.outcome === "failed") {
      logger.warn("deployment result marked attempt as failed; skipping deployment tracking side effects");
      return pullRequestUrl;
    }

    const context = this.readDeploymentSelectionContext(input.job.selectionContext);
    if (!context) {
      throw new ForemanError("missing_deployment_context", `Deployment job ${input.job.id} is missing deployment selection context.`);
    }

    pullRequestUrl = context.pullRequest.url;
    const prior = this.deps.foremanRepos.deploymentTracking.getDeploymentRecord({
      taskTargetId: input.target.id,
      prUrl: context.pullRequest.url,
      instructionHash: context.instructionHash,
    });

    const createdFollowUpTaskIds = [...(prior?.createdFollowUpTaskIds ?? [])];
    for (const mutation of workerResult.taskMutations) {
      if (mutation.type === "add_comment") {
        await this.deps.taskSystem.addComment({ taskId: input.task.id, body: mutation.body });
        logger.info("added deployment task comment from worker mutation");
      }
      if (mutation.type === "create_task") {
        const createdTask = await this.deps.taskSystem.createTask({ parentTask: input.task, mutation });
        createdFollowUpTaskIds.push(createdTask.id);
        this.deps.foremanRepos.attempts.addAttemptEvent(
          input.attempt.id,
          "task_created",
          `Created deployment follow-up task ${createdTask.id}`,
          { taskId: createdTask.id, providerId: createdTask.providerId, url: createdTask.url },
        );
        logger.info("created deployment follow-up task", {
          createdTaskId: createdTask.id,
          createdProviderId: createdTask.providerId,
          url: createdTask.url,
        });
      }
    }

    if (workerResult.outcome === "follow_up_created" && createdFollowUpTaskIds.length === (prior?.createdFollowUpTaskIds.length ?? 0)) {
      throw new ForemanError(
        "missing_deployment_follow_up",
        "Deployment result outcome follow_up_created must include at least one create_task mutation.",
      );
    }

    if (workerResult.outcome === "blocked") {
      for (const blocker of workerResult.blockers) {
        await this.deps.taskSystem.addComment({
          taskId: input.task.id,
          body: `${this.deps.config.workspace.agentPrefix}${blocker}`,
        });
        logger.warn("posted deployment blocker comment", { blocker });
      }
    }

    const shouldRetry = workerResult.outcome === "in_progress" || workerResult.outcome === "blocked";
    const retryCount = shouldRetry ? (prior?.retryCount ?? 0) + 1 : 0;
    const nextEligibleAt = shouldRetry
      ? addSeconds(
          new Date(),
          deploymentRetryIntervalMinutes({
            retryCount,
            minRetryIntervalMinutes: this.deps.config.deployment.minRetryIntervalMinutes,
            maxRetryIntervalMinutes: this.deps.config.deployment.maxRetryIntervalMinutes,
          }) * 60,
        )
      : null;
    const latestStatus = workerResult.outcome as DeploymentStatus;
    this.deps.foremanRepos.deploymentTracking.upsertDeploymentRecord({
      taskId: input.task.id,
      taskTargetId: input.target.id,
      repoKey: input.target.repoKey,
      prUrl: context.pullRequest.url,
      prNumber: context.pullRequest.number,
      prHeadBranch: context.pullRequest.headBranch,
      prBaseBranch: context.pullRequest.baseBranch,
      instructionHash: context.instructionHash,
      instructionBody: context.instructionBody,
      latestStatus,
      latestSummary: workerResult.summary,
      nextEligibleAt,
      retryCount,
      // Retained for deployment history/audit even though retry scheduling uses retryCount backoff.
      blockedRetryCount: (prior?.blockedRetryCount ?? 0) + (workerResult.outcome === "blocked" ? 1 : 0),
      createdFollowUpTaskIds,
      successful: workerResult.outcome === "succeeded",
      sourceAttemptId: input.attempt.id,
    });
    logger.info("persisted deployment tracking result", { latestStatus, nextEligibleAt });

    if (workerResult.outcome === "succeeded" && (await this.allRelevantDeploymentsSucceeded(input, context.instructionHash))) {
      await this.deps.taskSystem.transition({ taskId: input.task.id, toState: "done" });
      logger.info("transitioned task to done after all relevant deployments succeeded");
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

    this.deps.scheduleScout();
    return pullRequestUrl;
  }

  private readDeploymentSelectionContext(selectionContext: Record<string, unknown>): {
    instructionHash: string;
    instructionBody: string;
    pullRequest: { url: string; number: number; headBranch: string; baseBranch: string };
  } | null {
    const deployment = selectionContext.deployment;
    const pullRequest = selectionContext.pullRequestReference;
    if (!deployment || typeof deployment !== "object" || !pullRequest || typeof pullRequest !== "object") {
      return null;
    }

    const deploymentRecord = deployment as Record<string, unknown>;
    const pullRequestRecord = pullRequest as Record<string, unknown>;
    if (
      typeof deploymentRecord.instructionHash !== "string" ||
      typeof deploymentRecord.instructionBody !== "string" ||
      typeof pullRequestRecord.url !== "string" ||
      typeof pullRequestRecord.number !== "number" ||
      typeof pullRequestRecord.headBranch !== "string" ||
      typeof pullRequestRecord.baseBranch !== "string"
    ) {
      return null;
    }

    return {
      instructionHash: deploymentRecord.instructionHash,
      instructionBody: deploymentRecord.instructionBody,
      pullRequest: {
        url: pullRequestRecord.url,
        number: pullRequestRecord.number,
        headBranch: pullRequestRecord.headBranch,
        baseBranch: pullRequestRecord.baseBranch,
      },
    };
  }

  private async allRelevantDeploymentsSucceeded(input: ApplyWorkerResultInput, instructionHash: string): Promise<boolean> {
    let relevantCount = 0;
    const targets = this.deps.foremanRepos.taskMirror.getTargetsForTask(input.task.id);
    for (const target of targets.length > 0 ? targets : [input.target]) {
      const repo = this.deps.repos.find((item) => item.key === target.repoKey);
      if (!repo) {
        continue;
      }

      const pullRequest = await this.deps.reviewService.resolvePullRequest(input.task, repo, target);
      if (pullRequest?.state !== "merged") {
        continue;
      }

      relevantCount += 1;
      const record = this.deps.foremanRepos.deploymentTracking.getDeploymentRecord({
        taskTargetId: target.id,
        prUrl: pullRequest.pullRequestUrl,
        instructionHash,
      });
      if (!record?.successful) {
        return false;
      }
    }

    return relevantCount > 0;
  }

  private async saveReviewCheckpoint(input: ApplyWorkerResultInput, pullRequestUrl: string, logger: LoggerService): Promise<void> {
    const reviewContext =
      input.reviewContext ??
      (await this.deps.reviewService.getContext(
        input.task,
        this.deps.config.workspace.agentPrefix,
        input.repo,
        input.target,
      ));
    if (!reviewContext) {
      return;
    }

    try {
      this.deps.foremanRepos.reviewCheckpoints.upsertReviewCheckpoint({
        taskId: input.task.id,
        taskTargetId: input.target.id,
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

  private async recordPullRequest(taskId: string, pullRequest: TaskPullRequest, logger: LoggerService): Promise<void> {
    this.deps.foremanRepos.taskMirror.upsertTaskPullRequest({ taskId, pullRequest });
    try {
      await this.deps.taskSystem.upsertPullRequest({ taskId, pullRequest });
    } catch (error) {
      if (this.deps.taskSystem.getProvider() !== "linear") {
        throw error;
      }

      logger.warn("failed to sync pull request with Linear task provider", {
        taskId,
        repoKey: pullRequest.repoKey,
        pullRequestUrl: pullRequest.url,
        source: pullRequest.source,
        error: errorMessage(error),
      });
    }
  }
}
