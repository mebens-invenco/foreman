import type { Task, TaskComment, TaskCreateMutation, TaskProvider, TaskPullRequest, TaskState } from "../domain/index.js";

export type CreatedTask = {
  id: string;
  providerId: string;
  url: string | null;
};

export const taskCreateDescriptionBody = (mutation: TaskCreateMutation): string => mutation.description ?? mutation.body ?? "";

export const renderTaskCreateAgentMetadata = (
  mutation: Pick<TaskCreateMutation, "repos" | "dependencies" | "repoDependencies" | "branchName" | "baseBranch">,
): string => {
  const lines = ["Agent:", `  Repos: ${mutation.repos.join(", ")}`];
  const repoDependencies = mutation.repoDependencies ?? [];
  if (repoDependencies.length > 0) {
    lines.push(
      `  Repo dependencies: ${repoDependencies
        .map((dependency) => `${dependency.taskTargetRepoKey}<-${dependency.dependsOnRepoKey}`)
        .join(", ")}`,
    );
  }
  const taskIds = mutation.dependencies?.taskIds ?? [];
  if (taskIds.length > 0) {
    lines.push(`  Depends on tasks: ${taskIds.join(", ")}`);
  }
  if (mutation.dependencies?.baseTaskId) {
    lines.push(`  Base from task: ${mutation.dependencies.baseTaskId}`);
  }
  if (mutation.baseBranch) {
    lines.push(`  Base branch: ${mutation.baseBranch}`);
  }
  if (mutation.branchName) {
    lines.push(`  Branch: ${mutation.branchName}`);
  }
  return lines.join("\n");
};

export const renderTaskCreateDescription = (mutation: TaskCreateMutation): string => {
  const body = taskCreateDescriptionBody(mutation).trim();
  const metadata = renderTaskCreateAgentMetadata(mutation);
  return body ? `${body}\n\n${metadata}` : metadata;
};

export interface TaskSystem {
  getProvider(): TaskProvider;
  listCandidates(): Promise<Task[]>;
  // Every issue assigned to the configured user, regardless of agent label —
  // the superset of listCandidates(). Powers the manager's "all my tickets"
  // view, where untagged issues can be marked for Foreman. Read-only: these are
  // not mirrored as scheduling candidates.
  listAssignedIssues(): Promise<Task[]>;
  getTask(taskId: string): Promise<Task>;
  createTask(input: { parentTask: Task; mutation: TaskCreateMutation }): Promise<CreatedTask>;
  listComments(taskId: string): Promise<TaskComment[]>;
  addComment(input: { taskId: string; body: string }): Promise<void>;
  transition(input: { taskId: string; toState: TaskState }): Promise<void>;
  upsertPullRequest(input: { taskId: string; pullRequest: TaskPullRequest }): Promise<void>;
  updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void>;
  validateStartup?(): Promise<void>;
}
