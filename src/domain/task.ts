import type { AttemptStatus, WorkerResult } from "./orchestration.js";

export type TaskProvider = "linear" | "file";
export type TaskState = "ready" | "in_progress" | "in_review" | "done" | "canceled";
export type TaskPriority = "urgent" | "high" | "normal" | "none" | "low";
export type TaskTargetStatus = TaskState | "blocked";

export type TaskTarget = {
  id: string;
  taskId: string;
  repoKey: string;
  branchName: string;
  position: number;
};

export type TaskTargetRef = Pick<TaskTarget, "repoKey" | "branchName" | "position">;

export type TaskTargetDependencyRef = {
  taskTargetRepoKey: string;
  dependsOnRepoKey: string;
  position: number;
};

export type TaskArtifact = {
  type: "pull_request";
  url: string;
  title?: string;
  externalId?: string;
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
  targets: TaskTargetRef[];
  targetDependencies: TaskTargetDependencyRef[];
  dependencies: {
    taskIds: string[];
    baseTaskId: string | null;
  };
  artifacts: TaskArtifact[];
  updatedAt: string;
  url: string | null;
};

export const getTaskTargetRefsFromTask = (task: Pick<Task, "targets">): TaskTargetRef[] =>
  task.targets
    .map((target, position) => ({
      repoKey: target.repoKey,
      branchName: target.branchName,
      position: target.position ?? position,
    }))
    .sort((left, right) => left.position - right.position || left.repoKey.localeCompare(right.repoKey));

export const resolveTaskTargetRef = (
  task: Pick<Task, "targets">,
  repoKey?: string | null,
): TaskTargetRef | null => {
  const targets = getTaskTargetRefsFromTask(task);
  if (targets.length === 0) {
    return null;
  }
  if (repoKey) {
    return targets.find((target) => target.repoKey === repoKey) ?? null;
  }
  if (targets.length === 1) {
    return targets[0] ?? null;
  }
  return targets[0] ?? null;
};

export const resolveTaskBranchName = (
  task: Pick<Task, "id" | "targets">,
  target?: Pick<TaskTarget, "repoKey" | "branchName"> | null,
): string => target?.branchName ?? resolveTaskTargetRef(task, target?.repoKey)?.branchName ?? task.id.toLowerCase();

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
