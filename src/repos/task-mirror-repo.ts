import type { PersistedTaskTarget, Task } from "../domain/index.js";

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
  syncTasks(tasks: Task[]): void;
  saveTasks(tasks: Task[]): void;
  listTasks(): Task[];
  getTask(taskId: string): Task | null;
  getTaskTarget(taskId: string, repoKey: string): PersistedTaskTarget | null;
  getTaskTargetById(taskTargetId: string): PersistedTaskTarget | null;
  listTaskTargets(taskId: string): PersistedTaskTarget[];
  listTaskDependencies(taskId: string): TaskDependencyRecord[];
  listTaskTargetDependencies(taskId: string): TaskTargetDependencyRecord[];
}
