import type { Task } from "../../domain/index.js";

/**
 * Shared file-provider Task fixture for eval cases. Every eval case needs a Task
 * to render the worker prompt against; only the id/title/description/priority
 * vary per scenario, so the boilerplate (targets, dependencies, labels, …) lives
 * here once rather than per case file.
 */
export const fileTask = (id: string, title: string, description: string, priority: Task["priority"]): Task => ({
  id,
  provider: "file",
  providerId: id,
  title,
  description,
  state: "ready",
  providerState: "ready",
  priority,
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: "eval-repo", branchName: id.toLowerCase(), position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-06-01T00:00:00Z",
  url: null,
});
