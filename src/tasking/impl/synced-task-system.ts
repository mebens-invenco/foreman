import type { Task, TaskArtifact, TaskComment, TaskState } from "../../domain/index.js";
import type { TaskMirrorRepo } from "../../repos/task-mirror-repo.js";
import type { TaskSystem } from "../task-system.js";

const hydrateTaskFromMirror = (mirroredTask: Task | null, sourceTask: Task): Task => {
  if (!mirroredTask) {
    return sourceTask;
  }

  return {
    ...mirroredTask,
    branchName: mirroredTask.branchName ?? sourceTask.branchName,
    dependencies: {
      ...mirroredTask.dependencies,
      branchNames: sourceTask.dependencies.branchNames,
    },
    artifacts: sourceTask.artifacts,
  };
};

export class SyncedTaskSystem implements TaskSystem {
  constructor(
    private readonly delegate: TaskSystem,
    private readonly taskMirror: TaskMirrorRepo,
  ) {}

  getProvider() {
    return this.delegate.getProvider();
  }

  async listCandidates(): Promise<Task[]> {
    const tasks = await this.delegate.listCandidates();
    this.taskMirror.syncTasks(tasks);
    const mirroredTasks = this.taskMirror.getTasks(tasks.map((task) => task.id));
    const sourceTasksById = new Map(tasks.map((task) => [task.id, task]));
    return mirroredTasks.map((task) => hydrateTaskFromMirror(task, sourceTasksById.get(task.id) ?? task));
  }

  async getTask(taskId: string): Promise<Task> {
    const task = await this.delegate.getTask(taskId);
    this.taskMirror.syncTasks([task]);
    return hydrateTaskFromMirror(this.taskMirror.getTask(taskId), task);
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    return this.delegate.listComments(taskId);
  }

  async addComment(input: { taskId: string; body: string }): Promise<void> {
    return this.delegate.addComment(input);
  }

  async transition(input: { taskId: string; toState: TaskState }): Promise<void> {
    await this.delegate.transition(input);
    await this.getTask(input.taskId);
  }

  async addArtifact(input: { taskId: string; artifact: TaskArtifact }): Promise<void> {
    await this.delegate.addArtifact(input);
    await this.getTask(input.taskId);
  }

  async updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void> {
    await this.delegate.updateLabels(input);
    await this.getTask(input.taskId);
  }

  async validateStartup(): Promise<void> {
    await this.delegate.validateStartup?.();
  }
}
