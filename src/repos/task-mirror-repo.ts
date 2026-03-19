import type { Task, TaskPriority, TaskProvider, TaskState } from "../domain/index.js";

export type MirroredTaskRecord = {
  id: string;
  provider: TaskProvider;
  providerId: string;
  title: string;
  description: string;
  state: TaskState;
  providerState: string;
  priority: TaskPriority;
  assignee: string | null;
  url: string | null;
  updatedAt: string;
  syncedAt: string;
  labels: string[];
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
  source: "derived";
};

export interface TaskMirrorRepo {
  syncTasks(tasks: Task[]): void;
  getTask(taskId: string): Task | null;
  getTasks(taskIds: string[]): Task[];
  getMirroredTask(taskId: string): MirroredTaskRecord | null;
  listTaskTargets(taskId: string): TaskTargetRecord[];
  listTaskDependencies(taskId: string): TaskDependencyRecord[];
  listTaskTargetDependencies(taskId: string): TaskTargetDependencyRecord[];
}
