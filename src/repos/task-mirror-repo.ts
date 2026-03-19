import type { Task } from "../domain/index.js";

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
  source: "derived";
};

export interface TaskMirrorRepo {
  saveTasks(tasks: Task[]): void;
  getTask(taskId: string): Task | null;
  getTasks(taskIds: string[]): Task[];
  listTaskTargets(taskId: string): TaskTargetRecord[];
  listTaskDependencies(taskId: string): TaskDependencyRecord[];
  listTaskTargetDependencies(taskId: string): TaskTargetDependencyRecord[];
}
