import type { Task, TaskPullRequest, TaskTarget } from "../domain/index.js";

export type GetTasksOptions = {
  taskIds?: string[];
  state?: Task["state"];
  search?: string;
  limit?: number;
};

export type TaskDependencyRecord = {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  position: number;
  isBaseDependency: boolean;
};

export type TaskTargetDependencyRecord = {
  id: string;
  taskTargetId: string;
  dependsOnTaskTargetId: string;
  position: number;
  source: "derived" | "metadata";
};

export interface TaskMirrorRepo {
  saveTasks(tasks: Task[]): void;
  // Prune a task and its child rows (targets, pull requests, review/reviewer
  // checkpoints). Deletes children explicitly rather than leaning on FK cascade
  // so the prune holds regardless of the connection's foreign_keys pragma.
  deleteTasks(ids: string[]): void;
  // Update only a task's labels. Unlike saveTasks this touches no targets or
  // dependencies, so it's safe for a lightweight write (e.g. the agent-enabled
  // toggle) without triggering a full target-dependency rebuild. No-op if the
  // task isn't mirrored.
  setTaskLabels(taskId: string, labels: string[]): void;
  upsertTaskPullRequest(input: { taskId: string; pullRequest: TaskPullRequest }): void;
  getTasks(options?: GetTasksOptions): Task[];
  getTask(taskId: string): Task | null;
  getTaskTarget(taskId: string, repoKey: string): TaskTarget | null;
  getTaskTargetById(taskTargetId: string): TaskTarget | null;
  getTargetsForTask(taskId: string): TaskTarget[];
  getDependenciesForTask(taskId: string): TaskDependencyRecord[];
  getTargetDependenciesForTask(taskId: string): TaskTargetDependencyRecord[];
}
