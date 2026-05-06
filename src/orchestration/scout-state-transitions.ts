import type { RepoRef, ResolvedPullRequest, Task, TaskState, TaskTarget } from "../domain/index.js";
import { isoNow } from "../lib/time.js";
import type { LoggerService } from "../logger.js";
import type { AttemptRecord, ForemanRepos, JobRecord } from "../repos/index.js";
import { getProviderStateForNormalized, type TaskSystem } from "../tasking/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";

type TargetProgressState = "pending" | "active" | "in_review" | "merged" | "completed" | "retryable";

export type ScoutStateTransitionTargetProgress = {
  latestJob: JobRecord | null;
  latestAttempt: AttemptRecord | null;
  pullRequest: ResolvedPullRequest | null;
  state: TargetProgressState;
};

type PromotionRuleEvaluation =
  | { eligible: false; reason: string }
  | { eligible: true; reason: string; toState: TaskState };

type ScoutStatePromotionRule = {
  name: string;
  evaluate(input: {
    task: Task;
    targets: TaskTarget[];
    reposByKey: ReadonlyMap<string, RepoRef>;
    config: WorkspaceConfig;
    getTargetProgress(task: Task, target: TaskTarget, repo: RepoRef): Promise<ScoutStateTransitionTargetProgress>;
  }): Promise<PromotionRuleEvaluation>;
};

const mergedPullRequestPromotionRule: ScoutStatePromotionRule = {
  name: "merged_pull_requests",
  async evaluate(input) {
    if (input.task.state !== "in_review") {
      return { eligible: false, reason: "task_not_in_review" };
    }

    if (input.targets.length === 0) {
      return { eligible: false, reason: "missing_targets" };
    }

    for (const target of input.targets) {
      const repo = input.reposByKey.get(target.repoKey);
      if (!repo) {
        return { eligible: false, reason: `missing_repo:${target.repoKey}` };
      }

      const progress = await input.getTargetProgress(input.task, target, repo);
      if (progress.state === "active") {
        return { eligible: false, reason: `active_target:${target.repoKey}` };
      }
      if (!progress.pullRequest) {
        return { eligible: false, reason: `missing_pull_request:${target.repoKey}` };
      }
      if (progress.pullRequest.state !== "merged") {
        return { eligible: false, reason: `pull_request_not_merged:${target.repoKey}` };
      }
    }

    const doneOnMergeRepos = new Set(input.config.repos.reposDoneOnMerge);
    const toState = input.targets.every((target) => doneOnMergeRepos.has(target.repoKey)) ? "done" : "deployable";
    return { eligible: true, reason: "all_pull_requests_merged", toState };
  },
};

const promotionRules: ScoutStatePromotionRule[] = [mergedPullRequestPromotionRule];

export const runScoutStatePromotions = async (input: {
  config: WorkspaceConfig;
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
  tasks: Task[];
  reposByKey: ReadonlyMap<string, RepoRef>;
  getTargets(task: Task): TaskTarget[];
  getTargetProgress(task: Task, target: TaskTarget, repo: RepoRef): Promise<ScoutStateTransitionTargetProgress>;
  logger?: LoggerService;
}): Promise<void> => {
  for (const task of input.tasks) {
    for (const rule of promotionRules) {
      const evaluation = await rule.evaluate({
        task,
        targets: input.getTargets(task),
        reposByKey: input.reposByKey,
        config: input.config,
        getTargetProgress: input.getTargetProgress,
      });

      if (!evaluation.eligible) {
        input.logger?.debug("scout state promotion rule not eligible", {
          taskId: task.id,
          rule: rule.name,
          reason: evaluation.reason,
        });
        continue;
      }

      await input.taskSystem.transition({ taskId: task.id, toState: evaluation.toState });

      const mirroredTask = input.foremanRepos.taskMirror.getTask(task.id) ?? task;
      const updatedTask: Task = {
        ...mirroredTask,
        state: evaluation.toState,
        providerState: getProviderStateForNormalized(input.config, evaluation.toState),
        updatedAt: isoNow(),
      };
      Object.assign(task, updatedTask);
      input.foremanRepos.taskMirror.saveTasks([updatedTask]);

      input.logger?.info("promoted task state during scout", {
        taskId: task.id,
        rule: rule.name,
        toState: evaluation.toState,
        reason: evaluation.reason,
      });
      break;
    }
  }
};
