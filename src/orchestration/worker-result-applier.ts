import type {
  ActionType,
  LearningMutation,
  RepoRef,
  ReviewContext,
  ReviewMutation,
  Task,
  TaskPullRequest,
  TaskTarget,
  WorkerResult,
} from "../domain/index.js";
import { type Confidence } from "../curation/confidence-lifecycle.js";
import type { Embedder } from "../embeddings/embedder.js";
import { learningEmbeddingText } from "../embeddings/learning-embedding-text.js";
import { ForemanError } from "../lib/errors.js";
import { addSeconds } from "../lib/time.js";
import type { LoggerService } from "../logger.js";
import type { DeploymentStatus } from "../repos/deployment-tracking-repo.js";
import type { AttemptRecord, ForemanRepos, JobRecord } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import { blockedTaskUpdatedAtContextKey } from "./blocked-ordinary-work.js";

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
const blockedTaskReloadAttempts = 3;
const blockedTaskReloadRetryDelayMs = 50;

/** Cross-repo learnings, in scope for every repo's near-duplicate check. */
const sharedLearningRepo = "shared";

/**
 * The confidence a worker may store, clamped into the earned range. Two bounds,
 * both DL1 lean b:
 *
 * - Ceiling: only the curation pass mints `proven`, so a declared `proven` is
 *   stored as `established`.
 * - Floor: a worker `update` never lowers `proven`, the one tier the curation pass
 *   alone mints and retires. The floor is scoped to `proven` only — a lower tier a
 *   worker can itself declare (`established`) stays a worker's to walk back, so a
 *   mis-declared tier keeps a correction path instead of becoming permanent and,
 *   since decay only touches `emerging`, decay-immune.
 *
 * Adds have no stored tier (`stored` is undefined) and so are ceiling-only. Both
 * bounds live here, not in the worker-result schema, so the schema stays permissive
 * and an old runner emitting `proven` still parses — its claim is corrected, not
 * rejected.
 */
const resolveDeclaredConfidence = (
  declared: Confidence,
  stored: Confidence | undefined,
  context: Record<string, string>,
  logger: LoggerService,
): Confidence => {
  const capped = declared === "proven" ? "established" : declared;
  const resolved = stored === "proven" ? "proven" : capped;

  if (resolved !== declared) {
    logger.info("clamped worker-declared confidence to the earned range", { ...context, declared, resolved });
  }
  return resolved;
};

/**
 * Cosine similarity at or above which an added learning is flagged as a near
 * duplicate of its nearest in-scope neighbour. Calibrated for bge-small-en-v1.5
 * against the pinned corpus fixture; `learning-near-duplicate-calibration.test.ts`
 * re-derives it and fails if this value drifts out of the separating window.
 *
 * The five labelled near-identical pairs bottom out at 0.9151. The closest pair
 * that shares a topic but encodes a *distinct* rule scores 0.9067. 0.91 sits
 * inside that window, clear of both ends. Changing the embedding model
 * invalidates it.
 */
export const NEAR_DUPLICATE_SIMILARITY_THRESHOLD = 0.91;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  embedder: Embedder;
  logger: LoggerService;
  scheduleScout: () => void;
};

type PendingLearningEmbedding = {
  learningId: string;
  title: string;
  content: string;
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
      if (input.job.action === "execution" || input.job.action === "retry") {
        let blockedTaskUpdatedAt = input.task.updatedAt;
        for (let attempt = 1; attempt <= blockedTaskReloadAttempts; attempt += 1) {
          try {
            const blockedTask = await this.deps.taskSystem.getTask(input.task.id);
            blockedTaskUpdatedAt = blockedTask.updatedAt;
            break;
          } catch (error) {
            if (attempt < blockedTaskReloadAttempts) {
              logger.warn("failed to reload blocked task; retrying", {
                attempt,
                error: errorMessage(error),
              });
              await delay(blockedTaskReloadRetryDelayMs * attempt);
              continue;
            }
            logger.error("failed to reload blocked task; using pre-result task timestamp", {
              error: errorMessage(error),
              blockedTaskUpdatedAt,
            });
          }
        }
        this.deps.foremanRepos.jobs.updateJobSelectionContext(input.job.id, {
          ...input.job.selectionContext,
          [blockedTaskUpdatedAtContextKey]: blockedTaskUpdatedAt,
        });
        logger.info("saved blocked ordinary work checkpoint", { blockedTaskUpdatedAt });
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

    await this.applyLearningMutations(
      workerResult.learningMutations,
      { taskId: input.task.id, attemptId: input.attempt.id, action: input.job.action },
      logger,
    );

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

  private async applyLearningMutations(
    mutations: LearningMutation[],
    source: { taskId: string; attemptId: string; action: ActionType },
    logger: LoggerService,
  ): Promise<void> {
    const pending: PendingLearningEmbedding[] = [];
    // Adds are embedded before their rows exist, because the near-duplicate
    // lookup needs the new vector to find a neighbour to point at. Updates are
    // re-embedded on the deferred path below, flushed before each add's lookup
    // so no add ever queries a scope an earlier update has left a hole in.
    const addVectors = await this.embedAddedLearnings(mutations, logger);
    let addIndex = 0;

    for (const mutation of mutations) {
      if (mutation.type === "add") {
        const vector = addVectors[addIndex];
        addIndex += 1;

        // An update writes its row immediately but defers re-embedding, which
        // leaves the learning with no current vector in between. Flush the queue
        // first, or this lookup scans a scope with a hole in it and the add
        // lands unflagged against a neighbour that is really still there.
        await this.embedLearnings(pending.splice(0), logger);

        const nearDuplicate = vector ? this.findNearDuplicate(vector, mutation.repo, logger) : undefined;
        const learningId = this.deps.foremanRepos.learnings.addLearning({
          ...mutation,
          confidence: resolveDeclaredConfidence(mutation.confidence, undefined, { learningTitle: mutation.title, repo: mutation.repo }, logger),
          sourceTaskId: source.taskId,
          ...(nearDuplicate ? { duplicateOf: nearDuplicate.learningId } : {}),
        });
        logger.info("added learning mutation", { learningTitle: mutation.title, repo: mutation.repo });

        if (nearDuplicate) {
          logger.info("flagged learning as a near duplicate", {
            learningId,
            duplicateOf: nearDuplicate.learningId,
            similarity: nearDuplicate.similarity,
            threshold: NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
          });
        }

        if (vector) {
          // Store before the next add's lookup so two near-identical adds in one
          // worker result flag the second against the first.
          this.storeLearningEmbedding(learningId, mutation, vector, logger);
        }
      }
      if (mutation.type === "update") {
        // Read before the write: deciding whether to re-embed needs the pre-update text.
        const previous = this.deps.foremanRepos.learnings.getLearningsByIds([mutation.id])[0];
        this.deps.foremanRepos.learnings.updateLearning({
          ...mutation,
          ...(mutation.confidence !== undefined
            ? { confidence: resolveDeclaredConfidence(mutation.confidence, previous?.confidence, { learningId: mutation.id }, logger) }
            : {}),
        });
        logger.info("updated learning mutation", { learningId: mutation.id });

        if (mutation.markApplied) {
          this.recordLearningApplied(source, mutation.id, logger);
          this.stampInjectionApplied(source.attemptId, mutation.id, logger);
        }

        if (previous) {
          const next = {
            title: mutation.title ?? previous.title,
            content: mutation.content ?? previous.content,
          };
          // A tags/confidence/markApplied-only update leaves the vector valid.
          if (learningEmbeddingText(next) !== learningEmbeddingText(previous)) {
            pending.push({ learningId: mutation.id, ...next });
          }
        }
      }
    }

    await this.embedLearnings(pending, logger);
  }

  /**
   * Every apply, injected or self-found — the opposite of the injection stamp
   * below, which by design only marks what the digest actually pushed. Promotion
   * asks whether OTHER tasks found a learning useful, and a learning the agent
   * dug up by itself is evidence of exactly that.
   *
   * Its own try/catch, and not nested in the injection stamp: `updateLearning`
   * has already committed by the time either runs, so a telemetry insert that
   * fails must warn and let the apply stand.
   */
  private recordLearningApplied(
    source: { taskId: string; attemptId: string; action: ActionType },
    learningId: string,
    logger: LoggerService,
  ): void {
    try {
      this.deps.foremanRepos.learningUsage.recordApplied({ ...source, learningId });
    } catch (error) {
      logger.warn("failed to record learning applied event", { learningId, error: errorMessage(error) });
    }
  }

  /**
   * Stamping nothing is the expected outcome for a learning the agent found by
   * itself: `applied_count` still counts it, but a learning that was never pushed
   * cannot have been a hit for push injection, and the hit-rate must say so.
   */
  private stampInjectionApplied(attemptId: string, learningId: string, logger: LoggerService): void {
    try {
      const stamped = this.deps.foremanRepos.learningInjectionEvents.markInjectedLearningApplied({ attemptId, learningId });
      if (stamped > 0) {
        logger.info("stamped injected learning as applied", { learningId, injectionRowsStamped: stamped });
        return;
      }
      logger.debug("applied learning was not injected into this attempt", { learningId });
    } catch (error) {
      logger.warn("failed to stamp injected learning as applied", { learningId, error: errorMessage(error) });
    }
  }

  /**
   * One vector per `add` mutation, in mutation order. A failed embed yields
   * `undefined` for every add rather than throwing: the learning still lands
   * un-flagged, and `foreman learnings backfill-embeddings` picks up the row.
   * Losing dedup on one apply is cheaper than losing the learning.
   */
  private async embedAddedLearnings(
    mutations: LearningMutation[],
    logger: LoggerService,
  ): Promise<(Float32Array | undefined)[]> {
    const texts = mutations.filter((mutation) => mutation.type === "add").map(learningEmbeddingText);
    if (texts.length === 0) {
      return [];
    }

    try {
      const vectors = await this.deps.embedder.embed(texts);
      if (vectors.length !== texts.length) {
        throw new ForemanError(
          "embedding_count_mismatch",
          `Embedder returned ${vectors.length} vectors for ${texts.length} learnings`,
          500,
        );
      }
      return vectors;
    } catch (error) {
      logger.warn("failed to embed added learnings; skipping near-duplicate check", {
        learningCount: texts.length,
        error: errorMessage(error),
      });
      return texts.map(() => undefined);
    }
  }

  /**
   * Persists one add's vector. Never throws: the learning row is already
   * committed, so a failing embedding write (`SQLITE_BUSY`, `SQLITE_FULL`, ...)
   * must not abort the apply and strand the remaining mutations. The row is
   * left for `foreman learnings backfill-embeddings`, matching `embedLearnings`.
   */
  private storeLearningEmbedding(
    learningId: string,
    text: { title: string; content: string },
    vector: Float32Array,
    logger: LoggerService,
  ): void {
    try {
      const applied = this.deps.foremanRepos.learnings.upsertLearningEmbedding({
        learningId,
        model: this.deps.embedder.modelId,
        dims: this.deps.embedder.dims,
        vector,
        embeddedTitle: text.title,
        embeddedContent: text.content,
      });
      if (!applied) {
        // The row was created with exactly this text moments ago, so the
        // freshness guard can only reject if something rewrote it in between.
        logger.warn("embedding for freshly added learning rejected by freshness guard", { learningId });
      }
    } catch (error) {
      logger.warn("failed to store learning embedding; leaving row for backfill", {
        learningId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * The nearest neighbour in the mutation's repo plus `shared`, when it is close
   * enough to call a near duplicate. Never throws: a corrupt vector must not
   * cost us the learning, so a failed lookup degrades to storing it un-flagged.
   */
  private findNearDuplicate(
    vector: Float32Array,
    repo: string,
    logger: LoggerService,
  ): { learningId: string; similarity: number } | undefined {
    try {
      const nearest = this.deps.foremanRepos.learnings.nearestLearningEmbedding(vector, {
        model: this.deps.embedder.modelId,
        repos: Array.from(new Set([repo, sharedLearningRepo])),
      });

      return nearest && nearest.similarity >= NEAR_DUPLICATE_SIMILARITY_THRESHOLD ? nearest : undefined;
    } catch (error) {
      logger.warn("near-duplicate lookup failed; storing learning unflagged", {
        repo,
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  private async embedLearnings(pending: PendingLearningEmbedding[], logger: LoggerService): Promise<void> {
    if (pending.length === 0) {
      return;
    }

    try {
      const vectors = await this.deps.embedder.embed(pending.map(learningEmbeddingText));
      const raced: string[] = [];
      for (const [index, target] of pending.entries()) {
        const vector = vectors[index];
        if (!vector) {
          throw new ForemanError(
            "embedding_count_mismatch",
            `Embedder returned ${vectors.length} vectors for ${pending.length} learnings`,
            500,
          );
        }

        const applied = this.deps.foremanRepos.learnings.upsertLearningEmbedding({
          learningId: target.learningId,
          model: this.deps.embedder.modelId,
          dims: this.deps.embedder.dims,
          vector,
          embeddedTitle: target.title,
          embeddedContent: target.content,
        });
        if (!applied) {
          raced.push(target.learningId);
        }
      }

      logger.info("embedded learning mutations", { learningCount: pending.length - raced.length });
      if (raced.length > 0) {
        // The learning changed while we were embedding. Dropping the vector is
        // the safe outcome: the row stays stale-flagged for backfill.
        logger.warn("discarded embeddings for learnings edited mid-embed", { learningIds: raced.join(",") });
      }
    } catch (error) {
      // The learning write is the priority. A failed embed leaves the row for
      // `foreman learnings backfill-embeddings` rather than failing the apply.
      logger.warn("failed to embed learnings; leaving rows for backfill", {
        learningIds: pending.map((target) => target.learningId).join(","),
        error: errorMessage(error),
      });
    }
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

    const shouldRetry = workerResult.outcome === "in_progress" || workerResult.outcome === "blocked" || workerResult.outcome === "failed";
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

    await this.applyLearningMutations(
      workerResult.learningMutations,
      { taskId: input.task.id, attemptId: input.attempt.id, action: input.job.action },
      logger,
    );

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
