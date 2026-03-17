import type { Task, TaskArtifact, TaskComment, TaskProvider, TaskState } from "../domain.js";

export interface TaskSystem {
  getProvider(): TaskProvider;
  listCandidates(): Promise<Task[]>;
  getTask(taskId: string): Promise<Task>;
  listComments(taskId: string): Promise<TaskComment[]>;
  addComment(input: { taskId: string; body: string }): Promise<void>;
  transition(input: { taskId: string; toState: TaskState }): Promise<void>;
  addArtifact(input: { taskId: string; artifact: TaskArtifact }): Promise<void>;
  updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void>;
  validateStartup?(): Promise<void>;
}
