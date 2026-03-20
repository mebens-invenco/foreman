import type { Task } from "../domain/index.js";

export type GetTasksOptions = {
  taskIds?: string[];
  state?: Task["state"];
  search?: string;
  limit?: number;
};

export type TaskTargetRecord = {
  id: string;
  taskId: string;
  repoKey: string;
  branchName: string;
  position: number;
  createdAt: string;
  updatedAt: string;
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
  getTasks(options?: GetTasksOptions): Task[];
  getTask(taskId: string): Task | null;
  getTargetsForTask(taskId: string): TaskTargetRecord[];
  getDependenciesForTask(taskId: string): TaskDependencyRecord[];
  getTargetDependenciesForTask(taskId: string): TaskTargetDependencyRecord[];
}
