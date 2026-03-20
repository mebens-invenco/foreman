import type { Task, TaskTarget } from "../domain/index.js";

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
  source: "derived";
};

export interface TaskMirrorRepo {
  saveTasks(tasks: Task[]): void;
  getTasks(options?: GetTasksOptions): Task[];
  getTask(taskId: string): Task | null;
  getTaskTarget(taskId: string, repoKey: string): TaskTarget | null;
  getTaskTargetById(taskTargetId: string): TaskTarget | null;
  getTargetsForTask(taskId: string): TaskTarget[];
  getDependenciesForTask(taskId: string): TaskDependencyRecord[];
  getTargetDependenciesForTask(taskId: string): TaskTargetDependencyRecord[];
}
