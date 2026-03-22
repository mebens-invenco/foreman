import type { Task, TaskComment, TaskProvider, TaskPullRequest, TaskState } from "../domain/index.js";

export interface TaskSystem {
  getProvider(): TaskProvider;
  listCandidates(): Promise<Task[]>;
  getTask(taskId: string): Promise<Task>;
  listComments(taskId: string): Promise<TaskComment[]>;
  addComment(input: { taskId: string; body: string }): Promise<void>;
  transition(input: { taskId: string; toState: TaskState }): Promise<void>;
  upsertPullRequest(input: { taskId: string; pullRequest: TaskPullRequest }): Promise<void>;
  updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void>;
  validateStartup?(): Promise<void>;
}
