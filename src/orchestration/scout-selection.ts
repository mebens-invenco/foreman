import {
  actionableConversationComments,
  actionableReviewSummaries,
  actionableReviewThreadFingerprint,
  actionableReviewThreads,
  latestActionableConversationCommentId,
  latestActionableReviewSummaryId,
  priorityToRank,
  type ActionType,
  type RepoRef,
  type ResolvedPullRequest,
  type ReviewContext,
  type Task,
  type TaskComment,
  type TaskTarget,
  type TaskTargetRef,
} from "../domain/index.js";
import { ForemanError, isForemanError } from "../lib/errors.js";
import { stableStringify } from "../lib/json.js";
import type { LoggerService } from "../logger.js";
import type { AttemptRecord, ForemanRepos, JobRecord, ScoutRunTrigger } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import { resolveDeploymentInstructions, type DeploymentInstructions } from "../workspace/deployment.js";
import { branchExistsOnOrigin, resolveTaskBranchName } from "../workspace/git-worktrees.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";
import { evaluateBlockedOrdinaryWork, isBlockedOrdinaryWorkPendingUnblock, type TargetProgressState } from "./blocked-ordinary-work.js";
import { runStateTransitions } from "./state-transition.js";

type Selection = {
  task: Task;
  target: TaskTarget;
  action: ActionType;
  repo: RepoRef;
  baseBranch: string | null;
  priorityRank: number;
  selectionReason: string;
  selectionContext: Record<string, unknown>;
};

type TargetProgress = {
  latestJob: JobRecord | null;
  latestAttempt: AttemptRecord | null;
  pullRequest: ResolvedPullRequest | null;
  state: TargetProgressState;
};

const activeJobStatuses = new Set<JobRecord["status"]>(["queued", "leased", "running"]);
const stopIntentPhrases = ["abandon", "do not continue", "do not retry"];

const latestRetryWasManuallyStopped = (input: { foremanRepos: ForemanRepos; target: TaskTarget }): boolean => {
  const latestJob = input.foremanRepos.jobs.latestJobForTaskTarget(input.target.id);
  if (!latestJob || latestJob.action !== "retry" || latestJob.status !== "canceled") {
    return false;
  }

  const latestAttempt = input.foremanRepos.attempts.latestAttemptForTaskTarget(input.target.id);
  if (!latestAttempt || latestAttempt.jobId !== latestJob.id || latestAttempt.status !== "canceled") {
    return false;
  }

  return input.foremanRepos.attempts
    .listAttemptEvents(latestAttempt.id)
    .some((event) => event.eventType === "attempt_stop_requested");
};

const logBlockedOrdinaryWorkSkip = (logger: LoggerService | undefined, task: Task, target: TaskTarget, progress: TargetProgress): void => {
  const evaluation = evaluateBlockedOrdinaryWork(task, progress.latestJob, progress.latestAttempt);
  const context = {
    taskId: task.id,
    repoKey: target.repoKey,
    blockedTaskUpdatedAt: evaluation.blockedTaskUpdatedAt,
    taskUpdatedAt: task.updatedAt,
    reason: evaluation.reason,
  };
  if (evaluation.reason === "invalid_timestamp") {
    logger?.warn("skipping blocked ordinary work with invalid unblock timestamp", context);
    return;
  }
  logger?.info("skipping blocked ordinary work pending explicit unblock", context);
};

const reviewPriorityReason = (context: ReviewContext): string | null => {
  if (actionableReviewThreads(context).length > 0) {
    return "unresolved review threads";
  }
  if (actionableReviewSummaries(context).length > 0) {
    return "actionable review summary on current head";
  }
  if (actionableConversationComments(context).length > 0) {
    return "actionable pull request comment after current head";
  }
  if (context.failingChecks.length > 0) {
    return "failing checks";
  }
  if (context.mergeState === "conflicting") {
    return "merge conflicts";
  }
  return null;
};

const reviewSelectionContext = (context: ReviewContext): Record<string, unknown> => ({
  reviewContext: context,
  pullRequestReference: {
    provider: context.provider,
    url: context.pullRequestUrl,
    number: context.pullRequestNumber,
    state: context.state,
    isDraft: context.isDraft,
    headSha: context.headSha,
    headBranch: context.headBranch,
    baseBranch: context.baseBranch,
    headIntroducedAt: context.headIntroducedAt,
    mergeState: context.mergeState,
  },
});

const pullRequestReferenceContext = (pullRequest: ResolvedPullRequest): Record<string, unknown> => ({
  provider: "github",
  url: pullRequest.pullRequestUrl,
  number: pullRequest.pullRequestNumber,
  state: pullRequest.state,
  isDraft: pullRequest.isDraft,
  headBranch: pullRequest.headBranch,
  baseBranch: pullRequest.baseBranch,
});

const deploymentSelectionContext = (input: {
  instructions: DeploymentInstructions;
  pullRequest: ResolvedPullRequest;
}): Record<string, unknown> => ({
  pullRequestReference: pullRequestReferenceContext(input.pullRequest),
  deployment: {
    instructionHash: input.instructions.hash,
    instructionBody: input.instructions.body,
  },
});

const checkpointMatchesReviewState = (
  checkpoint:
    | {
        headSha: string;
        latestReviewSummaryId: string | null;
        latestConversationCommentId: string | null;
        reviewThreadsFingerprint: string;
        checksFingerprint: string;
        mergeState: ReviewContext["mergeState"];
      }
    | null,
  context: ReviewContext,
): boolean =>
  checkpoint
    ? checkpoint.headSha === context.headSha &&
      checkpoint.latestReviewSummaryId === latestActionableReviewSummaryId(context) &&
      checkpoint.latestConversationCommentId === latestActionableConversationCommentId(context) &&
      checkpoint.reviewThreadsFingerprint === actionableReviewThreadFingerprint(context) &&
      checkpoint.checksFingerprint === stableStringify({ failing: context.failingChecks, pending: context.pendingChecks }) &&
      checkpoint.mergeState === context.mergeState
    : false;

const reviewerCheckpointMatchesCommit = (
  checkpoint: { headSha: string } | null,
  context: ReviewContext,
): boolean => (checkpoint ? checkpoint.headSha === context.headSha : false);

const isTerminal = (task: Task): boolean => task.state === "done" || task.state === "canceled";

const isNoiseComment = (body: string, agentPrefix: string): boolean => !body.trim() || body.startsWith(agentPrefix);

const numericTaskId = (taskId: string): number => {
  const match = taskId.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

const hasStopIntent = (comments: TaskComment[], agentPrefix: string): boolean =>
  comments
    .filter((comment) => !isNoiseComment(comment.body, agentPrefix))
    .some((comment) => stopIntentPhrases.some((phrase) => comment.body.toLowerCase().includes(phrase)));

const compareExecutionTasks = (left: Task, right: Task): number => {
  const rankFor = (task: Task): number => {
    switch (task.state) {
      case "ready":
        return 0;
      case "in_progress":
        return 1;
      case "in_review":
        return 2;
      default:
        return 3;
    }
  };

  const stateDelta = rankFor(left) - rankFor(right);
  if (stateDelta !== 0) {
    return stateDelta;
  }

  const leftPriority = priorityToRank(left.priority);
  const rightPriority = priorityToRank(right.priority);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const updatedDelta = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return numericTaskId(left.id) - numericTaskId(right.id);
};

const targetKey = (taskId: string, repoKey: string): string => `${taskId}:${repoKey}`;
const dedupeKeyForAction = (taskId: string, repoKey: string, action: ActionType): string => `${taskId}:${repoKey}:${action}`;
// Cron jobs use CronAttemptExecutor and a cron lease, so they never consume task branch leases.
export const actionConsumesBranchLease = (action: ActionType): boolean => action !== "consolidation" && action !== "cron";

const resolvePersistedTaskTargets = (task: Task, foremanRepos: ForemanRepos): TaskTarget[] =>
  foremanRepos.taskMirror.getTargetsForTask(task.id);

const configuredAgentLabel = (config: WorkspaceConfig): string =>
  config.taskSystem.type === "linear" ? config.taskSystem.linear!.includeLabels[0]! : "Agent";

const configuredExcludeLabels = (config: WorkspaceConfig): string[] =>
  config.taskSystem.type === "linear" ? config.taskSystem.linear!.excludeLabels : [];

const configuredConsolidatedLabel = (config: WorkspaceConfig): string | null =>
  config.taskSystem.type === "linear" ? config.taskSystem.linear!.consolidatedLabel : null;

const syncResolvedPullRequest = (input: {
  task: Task;
  target: TaskTarget;
  foremanRepos: ForemanRepos;
  pullRequest: ResolvedPullRequest;
}): void => {
  const existing = input.task.pullRequests.find((pullRequest) => pullRequest.repoKey === input.target.repoKey);
  input.foremanRepos.taskMirror.upsertTaskPullRequest({
    taskId: input.task.id,
    pullRequest: {
      repoKey: input.target.repoKey,
      url: input.pullRequest.pullRequestUrl,
      ...(existing?.title ? { title: existing.title } : {}),
      source: existing?.source ?? "branch_inferred",
    },
  });
};

const resolveTargetProgress = async (input: {
  task: Task;
  target: TaskTarget;
  repo: RepoRef;
  foremanRepos: ForemanRepos;
  reviewService: ReviewService;
  selectedTargetKeys?: ReadonlySet<string>;
  resolvedPullRequestCache?: Map<string, Promise<ResolvedPullRequest | null>>;
}): Promise<TargetProgress> => {
  const selectedTargetKeys = input.selectedTargetKeys ?? new Set<string>();
  const latestJob = input.foremanRepos.jobs.latestJobForTaskTarget(input.target.id);
  const latestAttempt = input.foremanRepos.attempts.latestAttemptForTaskTarget(input.target.id);
  const pullRequestCacheKey = targetKey(input.task.id, input.target.repoKey);
  let pullRequestPromise = input.resolvedPullRequestCache?.get(pullRequestCacheKey);
  if (!pullRequestPromise) {
    pullRequestPromise = input.reviewService.resolvePullRequest(input.task, input.repo, input.target);
    input.resolvedPullRequestCache?.set(pullRequestCacheKey, pullRequestPromise);
  }
  const pullRequest = await pullRequestPromise;
  if (pullRequest) {
    syncResolvedPullRequest({
      task: input.task,
      target: input.target,
      foremanRepos: input.foremanRepos,
      pullRequest,
    });
  }

  if (selectedTargetKeys.has(targetKey(input.task.id, input.target.repoKey))) {
    return { latestJob, latestAttempt, pullRequest, state: "active" };
  }
  if (latestJob && activeJobStatuses.has(latestJob.status)) {
    return { latestJob, latestAttempt, pullRequest, state: "active" };
  }
  if (pullRequest?.state === "open") {
    return { latestJob, latestAttempt, pullRequest, state: "in_review" };
  }
  if (pullRequest?.state === "merged") {
    return { latestJob, latestAttempt, pullRequest, state: "merged" };
  }
  if (isBlockedOrdinaryWorkPendingUnblock(input.task, latestJob, latestAttempt)) {
    return { latestJob, latestAttempt, pullRequest, state: "blocked" };
  }
  if (pullRequest?.state === "closed") {
    return { latestJob, latestAttempt, pullRequest, state: "retryable" };
  }
  if (
    latestJob &&
    (latestJob.action === "execution" || latestJob.action === "retry") &&
    latestJob.status === "completed" &&
    latestAttempt?.status === "completed"
  ) {
    return { latestJob, latestAttempt, pullRequest, state: "completed" };
  }

  return { latestJob, latestAttempt, pullRequest, state: "pending" };
};

const satisfiesRepoDependency = (progress: TargetProgress): boolean =>
  progress.state === "in_review" || progress.state === "merged" || progress.state === "completed";

const satisfiesMergedDependency = (progress: TargetProgress): boolean =>
  progress.state === "merged" || progress.state === "completed";

const satisfiesCrossRepoTaskDependency = (task: Task): boolean => task.state === "done";

const isUnknownProviderStateError = (error: unknown): error is ForemanError =>
  isForemanError(error) && error.code === "unknown_provider_state";

export const resolveBaseBranch = async (input: {
  task: Task;
  target: TaskTarget;
  repo: RepoRef;
  repos: RepoRef[];
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  pendingSelections?: ReadonlyArray<Selection>;
  getTargetProgress?: (task: Task, target: TaskTarget, repo: RepoRef, selectedTargetKeys?: ReadonlySet<string>) => Promise<TargetProgress>;
}): Promise<{ baseBranch: string; blockers: string[] }> => {
  const blockers: string[] = [];
  const dependencies = input.task.dependencies.taskIds;
  const dependencyTaskCache = new Map<string, Promise<Task | null>>();
  const targetProgressCache = new Map<string, Promise<TargetProgress>>();
  const selectedTargetKeys = new Set((input.pendingSelections ?? []).map((selection) => targetKey(selection.task.id, selection.target.repoKey)));

  const getDependencyTask = async (taskId: string): Promise<Task | null> => {
    let promise = dependencyTaskCache.get(taskId);
    if (!promise) {
      promise = input.taskSystem
        .getTask(taskId)
        .then((task) => {
          input.foremanRepos.taskMirror.saveTasks([task]);
          return input.foremanRepos.taskMirror.getTask(task.id) ?? task;
        })
        .catch((error: unknown) => {
          if (isUnknownProviderStateError(error)) {
            blockers.push(`Dependency task ${taskId} cannot be evaluated because ${error.message}.`);
            return null;
          }
          throw error;
        });
      dependencyTaskCache.set(taskId, promise);
    }
    return promise;
  };

  const getDependencyTarget = async (taskId: string, repoKey: string): Promise<TaskTarget | null> => {
    const persisted = input.foremanRepos.taskMirror.getTaskTarget(taskId, repoKey);
    if (persisted) {
      return persisted;
    }

    const dependencyTask = await getDependencyTask(taskId);
    if (!dependencyTask) {
      return null;
    }
    return input.foremanRepos.taskMirror.getTaskTarget(taskId, repoKey);
  };

  const getTargetProgress = async (task: Task, target: TaskTarget, repo: RepoRef): Promise<TargetProgress> => {
    if (input.getTargetProgress) {
      return input.getTargetProgress(task, target, repo, selectedTargetKeys);
    }

    const cacheKey = targetKey(task.id, target.repoKey);
    let promise = targetProgressCache.get(cacheKey);
    if (!promise) {
      promise = resolveTargetProgress({
        task,
        target,
        repo,
        foremanRepos: input.foremanRepos,
        reviewService: input.reviewService,
        selectedTargetKeys,
      });
      targetProgressCache.set(cacheKey, promise);
    }
    return promise;
  };

  const ensureOriginBranch = async (branchName: string, blocker: string): Promise<boolean> => {
    const exists = await branchExistsOnOrigin(input.repo, branchName);
    if (!exists) {
      blockers.push(blocker);
    }
    return exists;
  };

  const resolveMatchedDependency = async (
    taskId: string,
  ): Promise<{ task: Task; target: TaskTarget; repo: RepoRef; progress: TargetProgress } | null> => {
    const dependencyTask = await getDependencyTask(taskId);
    if (!dependencyTask) {
      return null;
    }
    const dependencyTarget = await getDependencyTarget(taskId, input.target.repoKey);
    if (!dependencyTarget) {
      blockers.push(`Dependency task ${taskId} does not expose repo target ${input.target.repoKey}.`);
      return null;
    }

    const dependencyRepo = input.repos.find((repo) => repo.key === dependencyTarget.repoKey);
    if (!dependencyRepo) {
      blockers.push(`Dependency task ${taskId} repo target ${dependencyTarget.repoKey} was not discovered.`);
      return null;
    }

    return {
      task: dependencyTask,
      target: dependencyTarget,
      repo: dependencyRepo,
      progress: await getTargetProgress(dependencyTask, dependencyTarget, dependencyRepo),
    };
  };

  const resolveDependencyTarget = async (taskId: string): Promise<{ task: Task; target: TaskTarget | null } | null> => {
    const dependencyTask = await getDependencyTask(taskId);
    if (!dependencyTask) {
      return null;
    }

    return {
      task: dependencyTask,
      target: await getDependencyTarget(taskId, input.target.repoKey),
    };
  };

  const blockMissingDependencyTarget = (taskId: string): void => {
    blockers.push(`Dependency task ${taskId} does not expose repo target ${input.target.repoKey}.`);
  };

  const resolveDependencyBaseBranch = async (taskId: string): Promise<{ branch: string | null; merged: boolean }> => {
    const dependencyTarget = await resolveDependencyTarget(taskId);
    if (!dependencyTarget) {
      return { branch: null, merged: false };
    }

    if (!dependencyTarget.target) {
      if (satisfiesCrossRepoTaskDependency(dependencyTarget.task)) {
        return { branch: input.repo.defaultBranch, merged: true };
      }

      blockMissingDependencyTarget(taskId);
      return { branch: null, merged: false };
    }

    const dependency = await resolveMatchedDependency(taskId);
    if (!dependency) {
      return { branch: null, merged: false };
    }

    if (dependency.progress.state === "in_review" && dependency.progress.pullRequest) {
      const exists = await ensureOriginBranch(
        dependency.progress.pullRequest.headBranch,
        `Dependency task ${taskId} repo target ${input.target.repoKey} pull request head branch ${dependency.progress.pullRequest.headBranch} does not exist on origin.`,
      );
      return { branch: exists ? dependency.progress.pullRequest.headBranch : null, merged: false };
    }

    if (dependency.progress.state === "merged" && dependency.progress.pullRequest) {
      const exists = await ensureOriginBranch(
        dependency.progress.pullRequest.baseBranch,
        `Merged dependency task ${taskId} repo target ${input.target.repoKey} base branch ${dependency.progress.pullRequest.baseBranch} does not exist on origin.`,
      );
      return { branch: exists ? dependency.progress.pullRequest.baseBranch : null, merged: true };
    }

    if (dependency.progress.state === "completed") {
      return { branch: input.repo.defaultBranch, merged: false };
    }

    blockers.push(
      `Dependency task ${taskId} repo target ${input.target.repoKey} must be in review with an open pull request, completed without repo changes, or merged before scheduling.`,
    );
    return { branch: null, merged: false };
  };

  const ensureMergedDependency = async (taskId: string): Promise<void> => {
    const dependencyTarget = await resolveDependencyTarget(taskId);
    if (!dependencyTarget) {
      return;
    }

    if (!dependencyTarget.target) {
      if (satisfiesCrossRepoTaskDependency(dependencyTarget.task)) {
        return;
      }

      blockMissingDependencyTarget(taskId);
      return;
    }

    const dependency = await resolveMatchedDependency(taskId);
    if (!dependency) {
      return;
    }

    if (satisfiesMergedDependency(dependency.progress)) {
      if (dependency.progress.state === "merged" && dependency.progress.pullRequest) {
        await ensureOriginBranch(
          dependency.progress.pullRequest.baseBranch,
          `Merged dependency task ${taskId} repo target ${input.target.repoKey} base branch ${dependency.progress.pullRequest.baseBranch} does not exist on origin.`,
        );
      }
      return;
    }

    blockers.push(
      `Non-base dependency ${taskId} repo target ${input.target.repoKey} must be merged or completed without repo changes before scheduling.`,
    );
  };

  const targetDependencies = input.foremanRepos.taskMirror
    .getTargetDependenciesForTask(input.task.id)
    .filter((dependency) => dependency.source === "metadata" && dependency.taskTargetId === input.target.id);

  for (const dependency of targetDependencies) {
    const dependsOnTarget = input.foremanRepos.taskMirror.getTaskTargetById(dependency.dependsOnTaskTargetId);
    if (!dependsOnTarget) {
      blockers.push(`Repo dependency for ${input.target.repoKey} references a missing task target.`);
      continue;
    }

    const dependsOnRepo = input.repos.find((repo) => repo.key === dependsOnTarget.repoKey);
    if (!dependsOnRepo) {
      blockers.push(`Repo dependency for ${input.target.repoKey} references unknown repo ${dependsOnTarget.repoKey}.`);
      continue;
    }

    const dependencyProgress = await getTargetProgress(input.task, dependsOnTarget, dependsOnRepo);
    if (!satisfiesRepoDependency(dependencyProgress)) {
      blockers.push(`Target ${input.target.repoKey} is blocked until ${dependsOnTarget.repoKey} reaches review or completes.`);
    }
  }

  const explicitBaseBranch = input.task.baseBranch?.trim() || null;
  let baseBranch = explicitBaseBranch ?? input.repo.defaultBranch;

  if (explicitBaseBranch) {
    await ensureOriginBranch(explicitBaseBranch, `Explicit base branch ${explicitBaseBranch} does not exist on origin.`);
  }

  if (dependencies.length === 1) {
    const resolved = await resolveDependencyBaseBranch(dependencies[0]!);
    if (!explicitBaseBranch && resolved.branch) {
      baseBranch = resolved.branch;
    }
  } else if (dependencies.length > 1) {
    const baseTaskId = input.task.dependencies.baseTaskId;
    if (!baseTaskId && !explicitBaseBranch) {
      blockers.push("Base from task is required when Depends on tasks lists multiple tasks.");
      return { baseBranch, blockers };
    }

    if (baseTaskId && !dependencies.includes(baseTaskId)) {
      blockers.push("Base from task must be one of the listed task dependencies.");
      return { baseBranch, blockers };
    }

    for (const dependencyId of dependencies.filter((taskId) => taskId !== baseTaskId)) {
      await ensureMergedDependency(dependencyId);
    }

    if (baseTaskId) {
      const resolved = await resolveDependencyBaseBranch(baseTaskId);
      if (!explicitBaseBranch && resolved.branch) {
        baseBranch = resolved.branch;
      }
    }
  }

  if (blockers.length > 0) {
    return { baseBranch, blockers };
  }

  return { baseBranch, blockers };
};

export const runScoutSelection = async (input: {
  config: WorkspaceConfig;
  paths?: WorkspacePaths;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  repos: RepoRef[];
  triggerType: ScoutRunTrigger;
  logger?: LoggerService;
}): Promise<{ scoutRunId: string; jobs: Selection[]; excludedByLabelCount: number }> => {
  const logger = input.logger?.child({ component: "scout.selection", trigger: input.triggerType });
  const listedTasks = await input.taskSystem.listCandidates();
  input.foremanRepos.taskMirror.saveTasks(listedTasks);
  const mirroredTasks = listedTasks.map((task) => input.foremanRepos.taskMirror.getTask(task.id) ?? task);
  // Hard-skip any issue carrying a configured exclude label at candidate intake.
  // This is the single chokepoint that removes excluded issues from every
  // downstream action (state transitions, execution, review, reviewer, retry,
  // deployment, consolidation). Empty excludeLabels => identical to pre-filter behavior.
  const excludeLabels = configuredExcludeLabels(input.config);
  const allTasks =
    excludeLabels.length > 0
      ? mirroredTasks.filter((task) => !task.labels.some((label) => excludeLabels.includes(label)))
      : mirroredTasks;
  const excludedByLabelCount = mirroredTasks.length - allTasks.length;
  const reposByKey = new Map(input.repos.map((repo) => [repo.key, repo]));
  const deploymentInstructions = input.paths ? await resolveDeploymentInstructions(input.paths) : null;
  const resolvedPullRequestCache = new Map<string, Promise<ResolvedPullRequest | null>>();
  const targetProgressCache = new Map<string, Promise<TargetProgress>>();
  const getTargetProgress = async (
    task: Task,
    target: TaskTarget,
    repo: RepoRef,
    selectedTargetKeys: ReadonlySet<string> = new Set<string>(),
  ): Promise<TargetProgress> => {
    const selectedFingerprint = stableStringify([...selectedTargetKeys].sort());
    const cacheKey = `${targetKey(task.id, target.repoKey)}:${selectedFingerprint}`;
    let promise = targetProgressCache.get(cacheKey);
    if (!promise) {
      promise = resolveTargetProgress({
        task,
        target,
        repo,
        foremanRepos: input.foremanRepos,
        reviewService: input.reviewService,
        selectedTargetKeys,
        resolvedPullRequestCache,
      });
      targetProgressCache.set(cacheKey, promise);
    }
    return promise;
  };

  await runStateTransitions({
    config: input.config,
    foremanRepos: input.foremanRepos,
    taskSystem: input.taskSystem,
    tasks: allTasks,
    reposByKey,
    getTargets: (task) => resolvePersistedTaskTargets(task, input.foremanRepos),
    getTargetProgress: (task, target, repo) => getTargetProgress(task, target, repo),
    ...(logger ? { logger } : {}),
  });

  const activeCandidates = allTasks.filter(
    (task) => task.state === "ready" || task.state === "in_review" || task.state === "in_progress" || task.state === "deployable",
  );
  const executionCandidates = allTasks.filter(
    (task) => task.state === "ready" || task.state === "in_review" || task.state === "in_progress",
  );
  const terminalCandidates = allTasks.filter(isTerminal);

  const scoutRunId = input.foremanRepos.scoutRuns.createScoutRun({
    triggerType: input.triggerType,
    candidateCount: allTasks.length,
    activeCount: activeCandidates.length,
    terminalCount: terminalCandidates.length,
  });

  if (excludedByLabelCount > 0) {
    logger?.info("skipped tasks carrying an exclude label", {
      scoutRunId,
      excludedByLabelCount,
      excludeLabels: excludeLabels.join(", "),
    });
  }

  const availableCapacity = Math.max(0, input.config.scheduler.workerConcurrency - input.foremanRepos.jobs.activeJobCount());
  const jobs: Selection[] = [];
  const blockedReasons = new Set<string>();
  const activeJobsByTarget = new Map<string, JobRecord[]>();
  for (const job of input.foremanRepos.jobs.listJobsByStatus(["queued", "leased", "running"])) {
    if (!job.taskTargetId) {
      continue;
    }
    const existing = activeJobsByTarget.get(job.taskTargetId) ?? [];
    existing.push(job);
    activeJobsByTarget.set(job.taskTargetId, existing);
  }
  logger?.info("loaded scout candidates", {
    scoutRunId,
    candidateCount: allTasks.length,
    activeCount: activeCandidates.length,
    terminalCount: terminalCandidates.length,
    availableCapacity,
  });

  const canSchedule = (task: Task, target: TaskTarget, action: ActionType): boolean => {
    if (jobs.some((job) => job.task.id === task.id && job.target.repoKey === target.repoKey)) {
      return false;
    }

    const dedupeKey = dedupeKeyForAction(task.id, target.repoKey, action);
    if (jobs.some((job) => dedupeKeyForAction(job.task.id, job.target.repoKey, job.action) === dedupeKey)) {
      return false;
    }
    if (actionConsumesBranchLease(action) && (activeJobsByTarget.get(target.id) ?? []).some((job) => actionConsumesBranchLease(job.action))) {
      return false;
    }
    return !input.foremanRepos.jobs.hasActiveDedupeKey(dedupeKey);
  };

  const recordBlocker = async (taskId: string, body: string, options?: { postComment?: boolean }): Promise<void> => {
    const postComment = options?.postComment ?? true;
    const key = `${taskId}:${body}`;
    if (blockedReasons.has(key)) {
      return;
    }
    blockedReasons.add(key);
    logger?.info("blocking task during scout selection", { taskId, reason: body });
    if (!postComment) {
      return;
    }

    const commentBody = `${input.config.workspace.agentPrefix}${body}`;
    const latestComment = (await input.taskSystem.listComments(taskId))
      .slice()
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0];
    if (latestComment?.body === commentBody) {
      logger?.debug("skipping duplicate blocker comment during scout selection", { taskId, reason: body });
      return;
    }

    await input.taskSystem.addComment({ taskId, body: commentBody });
  };

  const targetReviewContextCache = new Map<string, Promise<ReviewContext | null>>();
  const getReviewContext = async (task: Task, target: TaskTarget, repo: RepoRef): Promise<ReviewContext | null> => {
    const cacheKey = targetKey(task.id, target.repoKey);
    let promise = targetReviewContextCache.get(cacheKey);
    if (!promise) {
      promise = input.reviewService.getContext(task, input.config.workspace.agentPrefix, repo, target);
      targetReviewContextCache.set(cacheKey, promise);
    }
    return promise;
  };

  const hasNonTerminalFollowUp = async (taskIds: string[]): Promise<boolean> => {
    for (const taskId of taskIds) {
      try {
        const task = await input.taskSystem.getTask(taskId);
        if (!isTerminal(task)) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  };

  for (let index = 0; index < availableCapacity; index += 1) {
    let chosen: Selection | null = null;

    for (const task of activeCandidates.filter((candidate) => candidate.state === "in_review" || candidate.state === "in_progress")) {
      for (const target of resolvePersistedTaskTargets(task, input.foremanRepos)) {
        if (!canSchedule(task, target, "review")) {
          continue;
        }

        const repo = reposByKey.get(target.repoKey);
        if (!repo) {
          await recordBlocker(task.id, `Review blocked because repo ${target.repoKey} was not discovered.`);
          continue;
        }

        const context = await getReviewContext(task, target, repo);
        if (!context || context.state !== "open") {
          continue;
        }

        const checkpoint = input.foremanRepos.reviewCheckpoints.getReviewCheckpoint(target.id);
        const checkpointMatches = checkpointMatchesReviewState(checkpoint, context);

        if (checkpoint && !checkpointMatches) {
          input.foremanRepos.reviewCheckpoints.deleteReviewCheckpoint(target.id);
        }

        if (checkpointMatches) {
          continue;
        }

        const reason = reviewPriorityReason(context);
        if (!reason) {
          continue;
        }

        chosen = {
          task,
          target,
          action: "review",
          repo,
          baseBranch: context.baseBranch,
          priorityRank: priorityToRank(task.priority),
          selectionReason: reason,
          selectionContext: reviewSelectionContext(context),
        };
        break;
      }

      if (chosen) {
        break;
      }
    }

    if (!chosen) {
      for (const task of activeCandidates.filter((candidate) => candidate.state === "in_review")) {
        for (const target of resolvePersistedTaskTargets(task, input.foremanRepos)) {
          if (!canSchedule(task, target, "retry")) {
            continue;
          }

          const repo = reposByKey.get(target.repoKey);
          if (!repo) {
            await recordBlocker(task.id, `Retry blocked because repo ${target.repoKey} was not discovered.`);
            continue;
          }

          const reviewContext = await getReviewContext(task, target, repo);
          if (!reviewContext || reviewContext.state !== "closed") {
            continue;
          }

          if (input.triggerType === "worker_finished" && latestRetryWasManuallyStopped({ foremanRepos: input.foremanRepos, target })) {
            continue;
          }

          const progress = await getTargetProgress(
            task,
            target,
            repo,
            new Set(jobs.map((job) => targetKey(job.task.id, job.target.repoKey))),
          );
          if (progress.state === "blocked") {
            logBlockedOrdinaryWorkSkip(logger, task, target, progress);
            continue;
          }

          const taskComments = await input.taskSystem.listComments(task.id);
          const combinedComments = [
            ...taskComments,
            ...reviewContext.conversationComments.map((comment) => ({
              ...comment,
              taskId: task.id,
              authorKind: comment.authoredByAgent ? ("agent" as const) : ("human" as const),
              updatedAt: null,
            })),
          ];
          if (hasStopIntent(combinedComments, input.config.workspace.agentPrefix)) {
            continue;
          }

          const base = await resolveBaseBranch({
            task,
            target,
            repo,
            repos: input.repos,
            foremanRepos: input.foremanRepos,
            taskSystem: input.taskSystem,
            reviewService: input.reviewService,
            pendingSelections: jobs,
            getTargetProgress,
          });
          if (base.blockers.length > 0) {
            for (const blocker of base.blockers) {
              await recordBlocker(task.id, blocker);
            }
            continue;
          }

          chosen = {
            task,
            target,
            action: "retry",
            repo,
            baseBranch: base.baseBranch,
            priorityRank: priorityToRank(task.priority),
            selectionReason: "closed unmerged pull request eligible for retry",
            selectionContext: {},
          };
          break;
        }

        if (chosen) {
          break;
        }
      }
    }

    if (!chosen) {
      for (const task of activeCandidates.filter((candidate) => candidate.state === "in_review")) {
        for (const target of resolvePersistedTaskTargets(task, input.foremanRepos)) {
          if (!canSchedule(task, target, "reviewer")) {
            continue;
          }

          const repo = reposByKey.get(target.repoKey);
          if (!repo) {
            await recordBlocker(task.id, `Reviewer blocked because repo ${target.repoKey} was not discovered.`);
            continue;
          }

          const reviewContext = await getReviewContext(task, target, repo);
          if (!reviewContext || reviewContext.state !== "open" || reviewContext.failingChecks.length > 0) {
            continue;
          }

          const checkpoint = input.foremanRepos.reviewerCheckpoints.getReviewerCheckpoint(target.id);
          const checkpointMatches = reviewerCheckpointMatchesCommit(checkpoint, reviewContext);

          if (checkpoint && !checkpointMatches) {
            input.foremanRepos.reviewerCheckpoints.deleteReviewerCheckpoint(target.id);
          }

          if (checkpointMatches) {
            continue;
          }

          chosen = {
            task,
            target,
            action: "reviewer",
            repo,
            baseBranch: reviewContext.baseBranch,
            priorityRank: priorityToRank(task.priority),
            selectionReason: reviewContext.isDraft ? "draft pull request eligible for reviewer pass" : "open pull request eligible for reviewer pass",
            selectionContext: reviewSelectionContext(reviewContext),
          };
          break;
        }

        if (chosen) {
          break;
        }
      }
    }

    if (!chosen) {
      if (deploymentInstructions) {
        for (const task of activeCandidates.filter((candidate) => candidate.state === "deployable")) {
          for (const target of resolvePersistedTaskTargets(task, input.foremanRepos)) {
            if (!canSchedule(task, target, "deployment")) {
              continue;
            }

            const repo = reposByKey.get(target.repoKey);
            if (!repo) {
              await recordBlocker(task.id, `Deployment blocked because repo ${target.repoKey} was not discovered.`);
              continue;
            }

            const pullRequest = await input.reviewService.resolvePullRequest(task, repo, target);
            if (pullRequest?.state !== "merged") {
              continue;
            }

            const record = input.foremanRepos.deploymentTracking.getDeploymentRecord({
              taskTargetId: target.id,
              prUrl: pullRequest.pullRequestUrl,
              instructionHash: deploymentInstructions.hash,
            });
            if (record?.successful) {
              continue;
            }

            if (record?.latestStatus === "follow_up_created" && (await hasNonTerminalFollowUp(record.createdFollowUpTaskIds))) {
              continue;
            }

            if (record?.nextEligibleAt && Date.parse(record.nextEligibleAt) > Date.now()) {
              continue;
            }

            chosen = {
              task,
              target,
              action: "deployment",
              repo,
              baseBranch: pullRequest.baseBranch,
              priorityRank: priorityToRank(task.priority),
              selectionReason: "merged pull request eligible for deployment tracking",
              selectionContext: deploymentSelectionContext({ instructions: deploymentInstructions, pullRequest }),
            };
            break;
          }

          if (chosen) {
            break;
          }
        }
      }
    }

    if (!chosen) {
      const sortedExecutionCandidates = executionCandidates.sort(compareExecutionTasks);

      for (const task of sortedExecutionCandidates) {
        const targets = resolvePersistedTaskTargets(task, input.foremanRepos);
        if (targets.length === 0) {
          await recordBlocker(task.id, "Execution blocked because Agent Repo metadata is missing.");
          continue;
        }

        for (const target of targets) {
          if (!canSchedule(task, target, "execution")) {
            continue;
          }

          const repo = reposByKey.get(target.repoKey);
          if (!repo) {
            await recordBlocker(task.id, `Execution blocked because repo ${target.repoKey} was not discovered.`);
            continue;
          }

          const progress = await getTargetProgress(
            task,
            target,
            repo,
            new Set(jobs.map((job) => targetKey(job.task.id, job.target.repoKey))),
          );
          if (progress.state === "blocked") {
            logBlockedOrdinaryWorkSkip(logger, task, target, progress);
            continue;
          }
          if (progress.state !== "pending") {
            continue;
          }

          const base = await resolveBaseBranch({
            task,
            target,
            repo,
            repos: input.repos,
            foremanRepos: input.foremanRepos,
            taskSystem: input.taskSystem,
            reviewService: input.reviewService,
            pendingSelections: jobs,
            getTargetProgress,
          });
          if (base.blockers.length > 0) {
            for (const blocker of base.blockers) {
              await recordBlocker(task.id, blocker, { postComment: false });
            }
            continue;
          }

          chosen = {
            task,
            target,
            action: "execution",
            repo,
            baseBranch: base.baseBranch,
            priorityRank: priorityToRank(task.priority),
            selectionReason:
              task.state === "ready"
                ? "highest priority ready repo target"
                : task.state === "in_progress"
                  ? "resumable in-progress repo target"
                  : "remaining repo target on in-review task",
            selectionContext: {},
          };
          break;
        }

        if (chosen) {
          break;
        }
      }
    }

    if (!chosen && input.config.scheduler.consolidateTerminalTasks) {
      const agentLabel = configuredAgentLabel(input.config);
      const consolidatedLabel = configuredConsolidatedLabel(input.config);

      for (const task of terminalCandidates) {
        if (!task.labels.includes(agentLabel)) {
          continue;
        }
        if (consolidatedLabel && task.labels.includes(consolidatedLabel)) {
          continue;
        }

        for (const target of resolvePersistedTaskTargets(task, input.foremanRepos)) {
          if (!canSchedule(task, target, "consolidation")) {
            continue;
          }

          // Consolidation is best-effort learning capture, capped to one
          // completed/failed/canceled attempt per terminal target. canSchedule
          // already excludes active (queued/leased/running) consolidations, so a
          // non-null latest job here is a prior attempt that has stopped running.
          // Skip it: a run that was canceled (e.g. the scheduler was paused
          // mid-pass and SIGTERM'd the worker) or failed must NOT be re-picked,
          // or a done task loops forever consuming worker slots.
          //
          // `blocked` is the exception. It is a transient interruption signal
          // (e.g. a provider rate limit — see attempt-executor.ts), not a real
          // attempt outcome, and unlike execution/retry work nothing else
          // re-picks a blocked consolidation (blocked-ordinary-work.ts is scoped
          // to execution/retry). Allow it through so the transient failure can be
          // retried rather than permanently dropping that task's learning harvest.
          const previousConsolidation = input.foremanRepos.jobs.latestJobForDedupeKey(
            dedupeKeyForAction(task.id, target.repoKey, "consolidation"),
          );
          if (previousConsolidation && previousConsolidation.status !== "blocked") {
            continue;
          }

          const repo = reposByKey.get(target.repoKey);
          if (!repo) {
            continue;
          }

          const pullRequest = await input.reviewService.resolvePullRequest(task, repo, target);
          if (pullRequest?.state === "open") {
            continue;
          }

          chosen = {
            task,
            target,
            action: "consolidation",
            repo,
            baseBranch: repo.defaultBranch,
            priorityRank: priorityToRank(task.priority),
            selectionReason: "terminal repo target eligible for label consolidation",
            selectionContext: {},
          };
          break;
        }

        if (chosen) {
          break;
        }
      }
    }

    if (!chosen) {
      break;
    }

    jobs.push(chosen);
    logger?.info("selected task for execution", {
      scoutRunId,
      taskId: chosen.task.id,
      targetRepo: chosen.target.repoKey,
      action: chosen.action,
      repo: chosen.repo.key,
      reason: chosen.selectionReason,
    });
  }

  logger?.info("completed scout selection", { scoutRunId, selectedJobs: jobs.length });
  return { scoutRunId, jobs, excludedByLabelCount };
};

export const assertTaskActionableTarget = <T extends TaskTargetRef>(
  task: Task,
  repos: RepoRef[],
  target: T | null,
): { target: T; repo: RepoRef } => {
  if (!target) {
    throw new ForemanError("task_missing_repo", `Task ${task.id} is missing repo metadata.`);
  }

  const repo = repos.find((item) => item.key === target.repoKey);
  if (!repo) {
    throw new ForemanError("task_invalid_repo", `Task ${task.id} references unknown repo ${target.repoKey}.`);
  }

  return { target, repo };
};

export const leaseResourceKeysForAction = (
  task: Task,
  action: ActionType,
  target: TaskTargetRef,
): Array<{ resourceType: "job" | "task" | "branch"; resourceKey: string }> => {
  const leases: Array<{ resourceType: "job" | "task" | "branch"; resourceKey: string }> = [
    { resourceType: "job", resourceKey: dedupeKeyForAction(task.id, target.repoKey, action) },
  ];

  if (actionConsumesBranchLease(action)) {
    leases.push({ resourceType: "branch", resourceKey: `${target.repoKey}:${resolveTaskBranchName(task, target)}` });
  }

  return leases;
};
