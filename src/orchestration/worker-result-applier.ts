import type { RepoRef, Task, TaskPullRequest, TaskTarget, WorkerResult } from "../domain/index.js";
import { ForemanError } from "../lib/errors.js";
import type { LoggerService } from "../logger.js";
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

type WorkerResultApplierDeps = {
  config: WorkspaceConfig;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
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
        await this.recordPullRequest(input.task.id, {
          repoKey: input.target.repoKey,
          url: created.url,
          title: mutation.title,
          source: "local",
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
        await this.recordPullRequest(input.task.id, {
          repoKey: input.target.repoKey,
          url: reopened.url,
          ...(mutation.title ? { title: mutation.title } : {}),
          source: "local",
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
      const resolvedPullRequest = await this.deps.reviewService.resolvePullRequest(input.task, input.repo, input.target);
      if (resolvedPullRequest?.state === "open") {
        pullRequestUrl = resolvedPullRequest.pullRequestUrl;
        await this.recordPullRequest(input.task.id, {
          repoKey: input.target.repoKey,
          url: resolvedPullRequest.pullRequestUrl,
          source: "branch_inferred",
        });
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
      const reviewContext = await this.deps.reviewService.getContext(
        input.task,
        this.deps.config.workspace.agentPrefix,
        input.repo,
        input.target,
      );
      if (reviewContext) {
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
    }

    this.deps.scheduleScout();
    logger.info("scheduled follow-up scout after task mutations", { pullRequestUrl });
    return pullRequestUrl;
  }

  private async resolveCurrentPullRequestUrl(task: Task, repo: RepoRef, target: TaskTarget): Promise<string | null> {
    const resolvedPullRequest = await this.deps.reviewService.resolvePullRequest(task, repo, target);
    return resolvedPullRequest?.pullRequestUrl ?? null;
  }

  private async recordPullRequest(taskId: string, pullRequest: TaskPullRequest): Promise<void> {
    await this.deps.taskSystem.upsertPullRequest({ taskId, pullRequest });
    this.deps.foremanRepos.taskMirror.upsertTaskPullRequest({ taskId, pullRequest });
  }
}
