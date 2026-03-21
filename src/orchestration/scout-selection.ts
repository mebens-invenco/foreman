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
import { ForemanError } from "../lib/errors.js";
import { stableStringify } from "../lib/json.js";
import type { LoggerService } from "../logger.js";
import type { AttemptRecord, ForemanRepos, JobRecord, ScoutRunTrigger } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import { branchExistsOnOrigin, resolveTaskBranchName } from "../workspace/git-worktrees.js";

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

type TargetProgressState = "pending" | "active" | "in_review" | "merged" | "completed" | "retryable";

type TargetProgress = {
  latestJob: JobRecord | null;
  latestAttempt: AttemptRecord | null;
  pullRequest: ResolvedPullRequest | null;
  state: TargetProgressState;
};

const activeJobStatuses = new Set<JobRecord["status"]>(["queued", "leased", "running"]);
const stopIntentPhrases = ["abandon", "do not continue", "do not retry"];

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

const resolvePersistedTaskTargets = (task: Task, foremanRepos: ForemanRepos): TaskTarget[] =>
  foremanRepos.taskMirror.getTargetsForTask(task.id);

const resolveTargetProgress = async (input: {
  task: Task;
  target: TaskTarget;
  repo: RepoRef;
  foremanRepos: ForemanRepos;
  reviewService: ReviewService;
  selectedTargetKeys?: ReadonlySet<string>;
}): Promise<TargetProgress> => {
  const selectedTargetKeys = input.selectedTargetKeys ?? new Set<string>();
  const latestJob = input.foremanRepos.jobs.latestJobForTaskTarget(input.target.id);
  const latestAttempt = input.foremanRepos.attempts.latestAttemptForTaskTarget(input.target.id);
  const pullRequest = await input.reviewService.resolvePullRequest(input.task, input.repo, input.target);

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

export const resolveBaseBranch = async (input: {
  task: Task;
  target: TaskTarget;
  repo: RepoRef;
  repos: RepoRef[];
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  pendingSelections?: ReadonlyArray<Selection>;
}): Promise<{ baseBranch: string; blockers: string[] }> => {
  const blockers: string[] = [];
  const dependencies = input.task.dependencies.taskIds;
  const dependencyTaskCache = new Map<string, Promise<Task>>();
  const targetProgressCache = new Map<string, Promise<TargetProgress>>();
  const selectedTargetKeys = new Set((input.pendingSelections ?? []).map((selection) => targetKey(selection.task.id, selection.target.repoKey)));

  const getDependencyTask = async (taskId: string): Promise<Task> => {
    let promise = dependencyTaskCache.get(taskId);
    if (!promise) {
      promise = input.taskSystem.getTask(taskId).then((task) => {
        input.foremanRepos.taskMirror.saveTasks([task]);
        return task;
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

    await getDependencyTask(taskId);
    return input.foremanRepos.taskMirror.getTaskTarget(taskId, repoKey);
  };

  const getTargetProgress = async (task: Task, target: TaskTarget, repo: RepoRef): Promise<TargetProgress> => {
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

  const resolveDependencyBaseBranch = async (taskId: string): Promise<{ branch: string | null; merged: boolean }> => {
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

  let baseBranch = input.repo.defaultBranch;

  if (dependencies.length === 1) {
    const resolved = await resolveDependencyBaseBranch(dependencies[0]!);
    if (resolved.branch) {
      baseBranch = resolved.branch;
    }
  } else if (dependencies.length > 1) {
    const baseTaskId = input.task.dependencies.baseTaskId;
    if (!baseTaskId) {
      blockers.push("Base from task is required when Depends on tasks lists multiple tasks.");
      return { baseBranch, blockers };
    }

    if (!dependencies.includes(baseTaskId)) {
      blockers.push("Base from task must be one of the listed task dependencies.");
      return { baseBranch, blockers };
    }

    for (const dependencyId of dependencies.filter((taskId) => taskId !== baseTaskId)) {
      await ensureMergedDependency(dependencyId);
    }

    const resolved = await resolveDependencyBaseBranch(baseTaskId);
    if (resolved.branch) {
      baseBranch = resolved.branch;
    }
  }

  if (blockers.length > 0) {
    return { baseBranch, blockers };
  }

  return { baseBranch, blockers };
};

export const runScoutSelection = async (input: {
  config: WorkspaceConfig;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  repos: RepoRef[];
  triggerType: ScoutRunTrigger;
  logger?: LoggerService;
}): Promise<{ scoutRunId: string; jobs: Selection[] }> => {
  const logger = input.logger?.child({ component: "scout.selection", trigger: input.triggerType });
  const allTasks = await input.taskSystem.listCandidates();
  input.foremanRepos.taskMirror.saveTasks(allTasks);
  const reposByKey = new Map(input.repos.map((repo) => [repo.key, repo]));
  const activeCandidates = allTasks.filter(
    (task) => task.state === "ready" || task.state === "in_review" || task.state === "in_progress",
  );
  const terminalCandidates = allTasks.filter(isTerminal);

  const scoutRunId = input.foremanRepos.scoutRuns.createScoutRun({
    triggerType: input.triggerType,
    candidateCount: allTasks.length,
    activeCount: activeCandidates.length,
    terminalCount: terminalCandidates.length,
  });

  const availableCapacity = Math.max(0, input.config.scheduler.workerConcurrency - input.foremanRepos.jobs.activeJobCount());
  const jobs: Selection[] = [];
  const blockedReasons = new Set<string>();
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
        const checkpointMatches = checkpoint
          ? checkpoint.headSha === context.headSha &&
            checkpoint.latestReviewSummaryId === latestActionableReviewSummaryId(context) &&
            checkpoint.latestConversationCommentId === latestActionableConversationCommentId(context) &&
            checkpoint.reviewThreadsFingerprint === actionableReviewThreadFingerprint(context) &&
            checkpoint.checksFingerprint === stableStringify({ failing: context.failingChecks, pending: context.pendingChecks }) &&
            checkpoint.mergeState === context.mergeState
          : false;

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
          selectionContext: { reviewContext: context },
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
      const executionCandidates = activeCandidates.sort(compareExecutionTasks);

      for (const task of executionCandidates) {
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

          const progress = await resolveTargetProgress({
            task,
            target,
            repo,
            foremanRepos: input.foremanRepos,
            reviewService: input.reviewService,
            selectedTargetKeys: new Set(jobs.map((job) => targetKey(job.task.id, job.target.repoKey))),
          });
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

    if (!chosen) {
      for (const task of terminalCandidates) {
        const agentLabel = input.config.taskSystem.type === "linear" ? input.config.taskSystem.linear!.includeLabels[0]! : "Agent";
        if (!task.labels.includes(agentLabel)) {
          continue;
        }

        for (const target of resolvePersistedTaskTargets(task, input.foremanRepos)) {
          if (!canSchedule(task, target, "consolidation")) {
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
  return { scoutRunId, jobs };
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

  if (action !== "consolidation") {
    leases.push({ resourceType: "branch", resourceKey: `${target.repoKey}:${resolveTaskBranchName(task, target)}` });
  }

  return leases;
};
