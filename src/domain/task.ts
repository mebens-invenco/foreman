import type { AttemptStatus, WorkerResult } from "./orchestration.js";

export type TaskProvider = "linear" | "file";
export type TaskState = "ready" | "in_progress" | "in_review" | "done" | "canceled";
export type TaskPriority = "urgent" | "high" | "normal" | "none" | "low";

export type TaskArtifact = {
  type: "pull_request";
  url: string;
  title?: string;
  externalId?: string;
  repo?: string;
};

export type TaskTarget = {
  repo: string;
  branchName: string;
  position: number;
};

export type TaskRepoDependency = {
  repo: string;
  dependsOnRepo: string;
  position: number;
};

export type Task = {
  id: string;
  provider: TaskProvider;
  providerId: string;
  title: string;
  description: string;
  state: TaskState;
  providerState: string;
  priority: TaskPriority;
  labels: string[];
  assignee: string | null;
  repo: string | null;
  branchName: string | null;
  targets?: TaskTarget[];
  repoDependencies?: TaskRepoDependency[];
  dependencies: {
    taskIds: string[];
    baseTaskId: string | null;
    branchNames: string[];
  };
  artifacts: TaskArtifact[];
  updatedAt: string;
  url: string | null;
};

export const resolveTaskTargets = (task: Task): TaskTarget[] => {
  if (task.targets && task.targets.length > 0) {
    return task.targets;
  }

  if (!task.repo) {
    return [];
  }

  return [
    {
      repo: task.repo,
      branchName: task.branchName ?? task.id.toLowerCase(),
      position: 0,
    },
  ];
};

export const resolveTaskTarget = (task: Task, repoKey: string): TaskTarget | null =>
  resolveTaskTargets(task).find((target) => target.repo === repoKey) ?? null;

export const resolveTaskRepoDependencies = (task: Task): TaskRepoDependency[] => task.repoDependencies ?? [];

export const resolveTaskBranchName = (task: Task, repoKey?: string): string => {
  if (repoKey) {
    return resolveTaskTarget(task, repoKey)?.branchName ?? task.branchName ?? task.id.toLowerCase();
  }

  const [onlyTarget] = resolveTaskTargets(task);
  return task.branchName ?? onlyTarget?.branchName ?? task.id.toLowerCase();
};

export type TaskComment = {
  id: string;
  taskId: string;
  body: string;
  authorName: string | null;
  authorKind: "agent" | "human" | "system" | "unknown";
  createdAt: string;
  updatedAt: string | null;
};

export const priorityToRank = (priority: TaskPriority): number => {
  switch (priority) {
    case "urgent":
      return 1;
    case "high":
      return 2;
    case "normal":
      return 3;
    case "none":
      return 4;
    case "low":
      return 5;
  }
};

export const deriveAttemptStatus = (workerResult: WorkerResult): AttemptStatus => {
  switch (workerResult.outcome) {
    case "completed":
    case "no_action_needed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
  }
};
