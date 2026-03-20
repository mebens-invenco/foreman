import {
  resolveTaskBranchName,
  resolveTaskRepoDependencies,
  resolveTaskTarget,
  resolveTaskTargets,
  type ActionType,
  type RepoRef,
  type ResolvedPullRequest,
  type ReviewContext,
  type Task,
  type TaskComment,
} from "../domain/index.js";
import {
  actionableReviewThreadFingerprint,
  actionableConversationComments,
  actionableReviewSummaries,
  actionableReviewThreads,
  latestActionableConversationCommentId,
  latestActionableReviewSummaryId,
  priorityToRank,
} from "../domain/index.js";
import { ForemanError } from "../lib/errors.js";
import { stableStringify } from "../lib/json.js";
import type { LoggerService } from "../logger.js";
import type { ForemanRepos, ScoutRunTrigger } from "../repos/index.js";
import type { ReviewService } from "../review/index.js";
import type { TaskSystem } from "../tasking/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import { branchExistsOnOrigin, isAncestorOnOrigin } from "../workspace/git-worktrees.js";

type Selection = {
  task: Task;
  action: ActionType;
  repo: RepoRef;
  baseBranch: string | null;
  priorityRank: number;
  selectionReason: string;
  selectionContext: Record<string, unknown>;
};

const taskLeaseKey = (taskId: string, repoKey: string): string => `${taskId}:${repoKey}`;
export const taskJobDedupeKey = (taskId: string, repoKey: string, action: ActionType): string => `${taskId}:${repoKey}:${action}`;

const taskForRepo = (task: Task, repoKey: string): Task | null => {
  const target = resolveTaskTarget(task, repoKey);
  if (!target) {
    return null;
  }

  return {
    ...task,
    repo: target.repo,
    branchName: target.branchName,
  };
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

const isTerminal = (task: Task): boolean => task.state === "done" || task.state === "canceled";

const isNoiseComment = (body: string, agentPrefix: string): boolean => !body.trim() || body.startsWith(agentPrefix);

const numericTaskId = (taskId: string): number => {
  const match = taskId.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

const stopIntentPhrases = ["abandon", "do not continue", "do not retry"];

const hasStopIntent = (comments: TaskComment[], agentPrefix: string): boolean =>
  comments
    .filter((comment) => !isNoiseComment(comment.body, agentPrefix))
    .some((comment) => stopIntentPhrases.some((phrase) => comment.body.toLowerCase().includes(phrase)));

const compareExecutionTasks = (left: Task, right: Task): number => {
  const leftReadyRank = left.state === "ready" ? 0 : 1;
  const rightReadyRank = right.state === "ready" ? 0 : 1;
  if (leftReadyRank !== rightReadyRank) {
    return leftReadyRank - rightReadyRank;
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

export const resolveBaseBranch = async (input: {
  task: Task;
  repo: RepoRef;
  repos: RepoRef[];
  taskSystem: TaskSystem;
  reviewService: ReviewService;
}): Promise<{ baseBranch: string; blockers: string[] }> => {
  const blockers: string[] = [];
  const dependencies = input.task.dependencies.taskIds;
  const selectedTarget = resolveTaskTarget(input.task, input.repo.key);

  if (!selectedTarget) {
    return {
      baseBranch: input.repo.defaultBranch,
      blockers: [`Task ${input.task.id} does not expose repo target ${input.repo.key}.`],
    };
  }

  const dependencyTaskCache = new Map<string, Promise<Task>>();
  const dependencyPullRequestCache = new Map<string, Promise<ResolvedPullRequest | null>>();

  const getDependencyTask = async (taskId: string): Promise<Task> => {
    let promise = dependencyTaskCache.get(taskId);
    if (!promise) {
      promise = input.taskSystem.getTask(taskId);
      dependencyTaskCache.set(taskId, promise);
    }
    return promise;
  };

  const getDependencyReviewContext = async (taskId: string, repoKey: string): Promise<ResolvedPullRequest | null> => {
    const cacheKey = `${taskId}:${repoKey}`;
    let promise = dependencyPullRequestCache.get(cacheKey);
    if (!promise) {
      promise = getDependencyTask(taskId).then(async (task) => {
        const dependencyRepo = input.repos.find((item) => item.key === repoKey);
        const scopedTask = taskForRepo(task, repoKey);
        if (!dependencyRepo || !scopedTask) {
          return null;
        }
        return input.reviewService.resolvePullRequest(scopedTask, dependencyRepo);
      });
      dependencyPullRequestCache.set(cacheKey, promise);
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

  const resolveDependencyBaseBranch = async (taskId: string): Promise<{ branch: string | null; merged: boolean }> => {
    const dependencyTask = await getDependencyTask(taskId);
    if (!resolveTaskTarget(dependencyTask, input.repo.key)) {
      blockers.push(`Dependency task ${taskId} does not expose repo target ${input.repo.key}.`);
      return { branch: null, merged: false };
    }

    const context = await getDependencyReviewContext(taskId, input.repo.key);
    if (context?.state === "open") {
      const exists = await ensureOriginBranch(
        context.headBranch,
        `Dependency task ${taskId} pull request head branch ${context.headBranch} does not exist on origin.`,
      );
      return { branch: exists ? context.headBranch : null, merged: false };
    }
    if (context?.state === "merged") {
      const exists = await ensureOriginBranch(
        context.baseBranch,
        `Merged dependency task ${taskId} base branch ${context.baseBranch} does not exist on origin.`,
      );
      return { branch: exists ? context.baseBranch : null, merged: true };
    }
    if (dependencyTask.state === "in_review") {
      blockers.push(`Dependency task ${taskId} must have an open pull request before scheduling.`);
      return { branch: null, merged: false };
    }

    blockers.push(`Dependency task ${taskId} must be in review with an open pull request or merged before scheduling.`);
    return { branch: null, merged: false };
  };

  const ensureMergedDependency = async (taskId: string): Promise<void> => {
    const dependencyTask = await getDependencyTask(taskId);
    if (!resolveTaskTarget(dependencyTask, input.repo.key)) {
      blockers.push(`Dependency task ${taskId} does not expose repo target ${input.repo.key}.`);
      return;
    }

    const context = await getDependencyReviewContext(taskId, input.repo.key);
    if (context?.state === "merged") {
      await ensureOriginBranch(
        context.baseBranch,
        `Merged dependency task ${taskId} base branch ${context.baseBranch} does not exist on origin.`,
      );
      return;
    }

    blockers.push(`Non-base dependency ${taskId} must be merged before scheduling.`);
  };

  const resolveMergedDependencyBaseBranch = async (branchName: string): Promise<string | null> => {
    for (const taskId of dependencies) {
      const dependencyTask = await getDependencyTask(taskId);
      if (!resolveTaskTarget(dependencyTask, input.repo.key)) {
        continue;
      }
      const context = await getDependencyReviewContext(taskId, input.repo.key);
      if (context?.state !== "merged") {
        continue;
      }
      if (resolveTaskBranchName(dependencyTask, input.repo.key) === branchName || context.headBranch === branchName) {
        return context.baseBranch;
      }
    }
    return null;
  };

  for (const dependency of resolveTaskRepoDependencies(input.task).filter((item) => item.repo === selectedTarget.repo)) {
    const dependencyRepo = input.repos.find((repo) => repo.key === dependency.dependsOnRepo);
    if (!dependencyRepo) {
      blockers.push(`Repo dependency ${dependency.dependsOnRepo} for target ${selectedTarget.repo} was not discovered.`);
      continue;
    }

    const scopedTask = taskForRepo(input.task, dependency.dependsOnRepo);
    if (!scopedTask) {
      blockers.push(`Task ${input.task.id} does not expose repo target ${dependency.dependsOnRepo}.`);
      continue;
    }

    const context = await input.reviewService.resolvePullRequest(scopedTask, dependencyRepo);
    if (context?.state === "open" || context?.state === "merged") {
      continue;
    }

    blockers.push(`Target ${selectedTarget.repo} is blocked until same-task repo target ${dependency.dependsOnRepo} reaches review or merged state.`);
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

    for (const dependencyId of dependencies.filter((item) => item !== baseTaskId)) {
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

  for (const branchName of input.task.dependencies.branchNames) {
    let effectiveBranchName = branchName;
    const exists = await branchExistsOnOrigin(input.repo, branchName);
    if (!exists) {
      const mergedBaseBranch = await resolveMergedDependencyBaseBranch(branchName);
      if (mergedBaseBranch) {
        effectiveBranchName = mergedBaseBranch;
      } else {
        blockers.push(`Dependency branch ${branchName} does not exist on origin.`);
        continue;
      }
    }

    const ancestor = await isAncestorOnOrigin(input.repo, effectiveBranchName, baseBranch);
    if (!ancestor) {
      if (effectiveBranchName === branchName) {
        blockers.push(`Dependency branch ${branchName} is not an ancestor of ${baseBranch}.`);
      } else {
        blockers.push(`Merged dependency branch ${branchName} resolves to ${effectiveBranchName}, which is not an ancestor of ${baseBranch}.`);
      }
    }
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
    (task) =>
      task.state === "ready" ||
      task.state === "in_review" ||
      task.state === "in_progress",
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

  const canSchedule = (task: Task, action: ActionType, repoKey: string): boolean => {
    const dedupeKey = taskJobDedupeKey(task.id, repoKey, action);
    if (jobs.some((job) => taskJobDedupeKey(job.task.id, job.repo.key, job.action) === dedupeKey)) {
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

  for (let index = 0; index < availableCapacity; index += 1) {
    let chosen: Selection | null = null;

    for (const task of activeCandidates.filter(
      (candidate) => candidate.state === "in_review" || candidate.state === "in_progress",
    )) {
      for (const target of resolveTaskTargets(task)) {
        if (!canSchedule(task, "review", target.repo)) {
          continue;
        }

        const repo = reposByKey.get(target.repo) ?? null;
        if (!repo) {
          await recordBlocker(task.id, `Review blocked because repo target ${target.repo} is missing or invalid.`);
          continue;
        }

        const scopedTask = taskForRepo(task, target.repo);
        if (!scopedTask) {
          continue;
        }

        const context = await input.reviewService.getContext(scopedTask, input.config.workspace.agentPrefix, repo);
        if (!context || context.state !== "open") {
          continue;
        }

        const checkpoint = input.foremanRepos.reviewCheckpoints.getReviewCheckpoint(task.id, context.pullRequestUrl);
        const checkpointMatches = checkpoint
          ? checkpoint.headSha === context.headSha &&
            checkpoint.latestReviewSummaryId === latestActionableReviewSummaryId(context) &&
            checkpoint.latestConversationCommentId === latestActionableConversationCommentId(context) &&
            checkpoint.reviewThreadsFingerprint === actionableReviewThreadFingerprint(context) &&
            checkpoint.checksFingerprint === stableStringify({ failing: context.failingChecks, pending: context.pendingChecks }) &&
            checkpoint.mergeState === context.mergeState
          : false;

        if (checkpoint && !checkpointMatches) {
          input.foremanRepos.reviewCheckpoints.deleteReviewCheckpoint(task.id, context.pullRequestUrl);
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
        for (const target of resolveTaskTargets(task)) {
          if (!canSchedule(task, "retry", target.repo)) {
            continue;
          }

          const repo = reposByKey.get(target.repo) ?? null;
          if (!repo) {
            await recordBlocker(task.id, `Retry blocked because repo target ${target.repo} is missing or invalid.`);
            continue;
          }

          const scopedTask = taskForRepo(task, target.repo);
          if (!scopedTask) {
            continue;
          }

          const reviewContext = await input.reviewService.getContext(scopedTask, input.config.workspace.agentPrefix, repo);
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
            repo,
            repos: input.repos,
            taskSystem: input.taskSystem,
            reviewService: input.reviewService,
          });
          if (base.blockers.length > 0) {
            for (const blocker of base.blockers) {
              await recordBlocker(task.id, blocker);
            }
            continue;
          }

          chosen = {
            task,
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
      const executionCandidates = activeCandidates
        .filter((task) => task.state === "ready" || task.state === "in_progress" || task.state === "in_review")
        .sort(compareExecutionTasks);

      for (const task of executionCandidates) {
        const targets = resolveTaskTargets(task);
        if (targets.length === 0) {
          await recordBlocker(task.id, "Execution blocked because Agent Repo metadata is missing.");
          continue;
        }

        for (const target of targets) {
          if (!canSchedule(task, "execution", target.repo)) {
            continue;
          }
          if (input.foremanRepos.leases.hasActiveTaskLease(taskLeaseKey(task.id, target.repo))) {
            continue;
          }

          const repo = reposByKey.get(target.repo);
          if (!repo) {
            await recordBlocker(task.id, `Execution blocked because repo ${target.repo} was not discovered.`);
            continue;
          }

          const scopedTask = taskForRepo(task, target.repo);
          if (!scopedTask) {
            continue;
          }

          const existingPullRequest = await input.reviewService.resolvePullRequest(scopedTask, repo);
          if (existingPullRequest) {
            continue;
          }

          const base = await resolveBaseBranch({
            task,
            repo,
            repos: input.repos,
            taskSystem: input.taskSystem,
            reviewService: input.reviewService,
          });
          if (base.blockers.length > 0) {
            for (const blocker of base.blockers) {
              await recordBlocker(task.id, blocker, { postComment: false });
            }
            continue;
          }

          chosen = {
            task,
            action: "execution",
            repo,
            baseBranch: base.baseBranch,
            priorityRank: priorityToRank(task.priority),
            selectionReason: task.state === "ready" ? "highest priority ready task target" : "resumable in-progress task target without active lease",
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
        const [firstTarget] = resolveTaskTargets(task);
        if (!firstTarget || !canSchedule(task, "consolidation", firstTarget.repo)) {
          continue;
        }

        const agentLabel = input.config.taskSystem.type === "linear" ? input.config.taskSystem.linear!.includeLabels[0]! : "Agent";
        if (!task.labels.includes(agentLabel)) {
          continue;
        }

        const repo = resolveTaskTargets(task)
          .map((target) => reposByKey.get(target.repo) ?? null)
          .find((candidate) => candidate !== null);
        if (!repo) {
          continue;
        }

        const prUrls = task.artifacts.filter((artifact) => artifact.type === "pull_request").map((artifact) => artifact.url);
        let allClosed = true;
        for (const prUrl of prUrls) {
          const context = await input.reviewService.getContext(
            { ...task, artifacts: [{ type: "pull_request", url: prUrl }] },
            input.config.workspace.agentPrefix,
            repo,
          );
          if (context?.state === "open") {
            allClosed = false;
            break;
          }
        }

        if (!allClosed) {
          continue;
        }

        chosen = {
          task,
          action: "consolidation",
          repo,
          baseBranch: repo.defaultBranch,
          priorityRank: priorityToRank(task.priority),
          selectionReason: "terminal task eligible for label consolidation",
          selectionContext: {},
        };
        break;
      }
    }

      if (!chosen) {
        break;
      }

      jobs.push(chosen);
      logger?.info("selected task for execution", {
        scoutRunId,
        taskId: chosen.task.id,
        action: chosen.action,
        repo: chosen.repo.key,
        reason: chosen.selectionReason,
      });
  }

  logger?.info("completed scout selection", { scoutRunId, selectedJobs: jobs.length });
  return { scoutRunId, jobs };
};

export const assertTaskActionableRepo = (task: Task, repoKey: string, repos: RepoRef[]): RepoRef => {
  if (!resolveTaskTarget(task, repoKey)) {
    throw new ForemanError("task_missing_repo", `Task ${task.id} is missing repo target ${repoKey}.`);
  }

  const repo = repos.find((item) => item.key === repoKey);
  if (!repo) {
    throw new ForemanError("task_invalid_repo", `Task ${task.id} references unknown repo ${repoKey}.`);
  }

  return repo;
};

export const leaseResourceKeysForAction = (
  task: Task,
  repoKey: string,
  action: ActionType,
): Array<{ resourceType: "job" | "task" | "branch"; resourceKey: string }> => {
  const leases: Array<{ resourceType: "job" | "task" | "branch"; resourceKey: string }> = [
    { resourceType: "job", resourceKey: taskJobDedupeKey(task.id, repoKey, action) },
    { resourceType: "task", resourceKey: taskLeaseKey(task.id, repoKey) },
  ];

  if (action !== "consolidation") {
    leases.push({ resourceType: "branch", resourceKey: `${repoKey}:${resolveTaskBranchName(task, repoKey)}` });
  }

  return leases;
};
