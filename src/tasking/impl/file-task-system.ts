import { promises as fs } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import YAML from "yaml";

import {
  getTaskTargetRefsFromTask,
  type Task,
  type TaskComment,
  type TaskPullRequest,
  type TaskRunnerOverride,
  type TaskState,
  type TaskTargetDependencyRef,
  type TaskTargetRef,
} from "../../domain/index.js";
import { ForemanError, isForemanError } from "../../lib/errors.js";
import { atomicWriteFile, ensureDir, pathExists } from "../../lib/fs.js";
import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import { LoggerService } from "../../logger.js";
import type { WorkspaceConfig } from "../../workspace/config.js";
import type { WorkspacePaths } from "../../workspace/workspace-paths.js";
import { normalizeTaskRunnerOverride, serializeTaskRunnerOverride } from "../task-runner-override.js";
import { renderTaskCreateDescription, type CreatedTask, type TaskSystem } from "../task-system.js";
import { getProviderStateForNormalized, normalizeTaskState } from "../task-state-mapping.js";

const normalizePriority = (value: unknown): Task["priority"] => {
  const normalized = String(value ?? "none").toLowerCase();
  switch (normalized) {
    case "urgent":
    case "high":
    case "normal":
    case "low":
    case "none":
      return normalized;
    default:
      return "none";
  }
};

const normalizeAuthorKind = (value: unknown): TaskComment["authorKind"] => {
  const normalized = String(value ?? "unknown").toLowerCase();
  switch (normalized) {
    case "agent":
    case "human":
    case "system":
      return normalized;
    default:
      return "unknown";
  }
};

type FileTaskFrontmatter = {
  id: string;
  title: string;
  state: string;
  priority: string;
  labels?: string[];
  targets?: TaskTargetRef[];
  targetDependencies?: TaskTargetDependencyRef[];
  repo?: string | null;
  branchName?: string | null;
  dependsOnTasks?: string[];
  baseFromTask?: string | null;
  baseBranch?: string | null;
  dependsOnBranches?: string[];
  pullRequests?: TaskPullRequest[];
  runner?: Record<string, unknown> | null;
  assignee?: string | null;
  createdAt: string;
  updatedAt: string;
};

const fileFrontmatterOrder: Array<keyof FileTaskFrontmatter> = [
  "id",
  "title",
  "state",
  "priority",
  "labels",
  "targets",
  "targetDependencies",
  "dependsOnTasks",
  "baseFromTask",
  "baseBranch",
  "pullRequests",
  "runner",
  "assignee",
  "createdAt",
  "updatedAt",
];

const stringifyFileTask = (frontmatter: FileTaskFrontmatter, body: string): string => {
  const ordered: Record<string, unknown> = {};
  for (const key of fileFrontmatterOrder) {
    const value = frontmatter[key];
    if (key === "runner" && (value === null || value === undefined)) {
      continue;
    }
    ordered[key] = value;
  }
  const yaml = YAML.stringify(ordered).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
};

const normalizeTaskTargets = (data: FileTaskFrontmatter): TaskTargetRef[] => {
  if (data.targets && data.targets.length > 0) {
    return data.targets
      .map((target, position) => ({
        repoKey: target.repoKey,
        branchName: target.branchName,
        position: target.position ?? position,
      }))
      .sort((left, right) => left.position - right.position || left.repoKey.localeCompare(right.repoKey));
  }

  if (!data.repo) {
    return [];
  }

  return [
    {
      repoKey: data.repo,
      branchName: data.branchName ?? data.id.toLowerCase(),
      position: 0,
    },
  ];
};

const normalizeTargetDependencies = (data: FileTaskFrontmatter): TaskTargetDependencyRef[] =>
  (data.targetDependencies ?? [])
    .map((dependency, position) => ({
      taskTargetRepoKey: dependency.taskTargetRepoKey,
      dependsOnRepoKey: dependency.dependsOnRepoKey,
      position: dependency.position ?? position,
    }))
    .sort((left, right) => left.position - right.position || left.taskTargetRepoKey.localeCompare(right.taskTargetRepoKey));

const parseFileTaskDocument = (config: WorkspaceConfig, filePath: string, contents: string): Task => {
  const parsed = matter(contents);
  const data = parsed.data as FileTaskFrontmatter;
  const stem = path.basename(filePath, ".md");
  if (data.id !== stem) {
    throw new ForemanError("invalid_file_task", `Task id ${data.id} does not match filename ${stem}`);
  }
  if ((data.dependsOnBranches?.length ?? 0) > 0) {
    throw new ForemanError(
      "invalid_task_metadata",
      `Task ${data.id} uses deprecated dependsOnBranches metadata; use task dependencies and repo dependencies instead.`,
    );
  }

  const targets = normalizeTaskTargets(data);
  const targetDependencies = normalizeTargetDependencies(data);

  return {
    id: data.id,
    provider: "file",
    providerId: data.id,
    title: data.title,
    description: parsed.content.trim(),
    state: normalizeTaskState(config, data.state),
    providerState: data.state,
    priority: normalizePriority(data.priority),
    labels: data.labels ?? [],
    assignee: data.assignee ?? null,
    targets,
    targetDependencies,
    dependencies: {
      taskIds: data.dependsOnTasks ?? [],
      baseTaskId: data.baseFromTask ?? null,
    },
    baseBranch: data.baseBranch ?? null,
    pullRequests: data.pullRequests ?? [],
    runnerOverride: normalizeTaskRunnerOverride(data.runner),
    updatedAt: data.updatedAt,
    url: null,
  };
};

const toFileFrontmatter = (task: Task, createdAt: string): FileTaskFrontmatter => {
  const targets = getTaskTargetRefsFromTask(task);
  return {
    id: task.id,
    title: task.title,
    state: task.providerState,
    priority: task.priority,
    labels: task.labels,
    targets,
    targetDependencies: task.targetDependencies,
    dependsOnTasks: task.dependencies.taskIds,
    baseFromTask: task.dependencies.baseTaskId,
    baseBranch: task.baseBranch,
    pullRequests: task.pullRequests,
    runner: serializeTaskRunnerOverride(task.runnerOverride),
    assignee: task.assignee,
    createdAt,
    updatedAt: task.updatedAt,
  };
};

const fileCommentsPath = (taskPath: string): string => taskPath.replace(/\.md$/, ".comments.ndjson");

const isUnknownProviderStateError = (error: unknown): error is ForemanError =>
  isForemanError(error) && error.code === "unknown_provider_state";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class FileTaskSystem implements TaskSystem {
  private readonly logger: LoggerService;

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly paths: WorkspacePaths,
    logger?: LoggerService,
  ) {
    this.logger = (logger ?? LoggerService.create({ context: { component: "taskSystem.file" }, colorMode: "never" })).child({
      component: "taskSystem.file",
    });
  }

  getProvider(): "file" {
    return "file";
  }

  private get taskDir(): string {
    return path.join(this.paths.workspaceRoot, this.config.taskSystem.file!.tasksDir);
  }

  private async listTaskFiles(): Promise<string[]> {
    await ensureDir(this.taskDir);
    return fg("*.md", { cwd: this.taskDir, absolute: true, onlyFiles: true }).then((entries) => entries.sort());
  }

  private async nextTaskId(): Promise<string> {
    const prefix = this.config.taskSystem.file!.idPrefix;
    const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`);
    let max = 0;
    for (const filePath of await this.listTaskFiles()) {
      const match = path.basename(filePath, ".md").match(pattern);
      if (match) {
        max = Math.max(max, Number.parseInt(match[1]!, 10));
      }
    }
    return `${prefix}-${String(max + 1).padStart(4, "0")}`;
  }

  private async loadTaskDocument(taskId: string): Promise<{ task: Task; frontmatter: FileTaskFrontmatter; path: string }> {
    const taskPath = path.join(this.taskDir, `${taskId}.md`);
    if (!(await pathExists(taskPath))) {
      throw new ForemanError("task_not_found", `Task not found: ${taskId}`, 404);
    }

    const contents = await fs.readFile(taskPath, "utf8");
    const parsed = matter(contents);
    return {
      task: parseFileTaskDocument(this.config, taskPath, contents),
      frontmatter: parsed.data as FileTaskFrontmatter,
      path: taskPath,
    };
  }

  async listCandidates(): Promise<Task[]> {
    const files = await this.listTaskFiles();
    const tasks = await Promise.all(
      files.map(async (filePath) => {
        const contents = await fs.readFile(filePath, "utf8");
        const parsed = matter(contents);
        const frontmatter = parsed.data as Partial<FileTaskFrontmatter>;

        try {
          return parseFileTaskDocument(this.config, filePath, contents);
        } catch (error) {
          if (!isUnknownProviderStateError(error)) {
            throw error;
          }

          this.logger.info("skipping file candidate with unmapped provider state", {
            provider: "file",
            taskId: typeof frontmatter.id === "string" ? frontmatter.id : null,
            filePath,
            providerState: typeof frontmatter.state === "string" ? frontmatter.state : null,
          });
          return null;
        }
      }),
    );

    return tasks.flatMap((task) => (task ? [task] : []));
  }

  async getTask(taskId: string): Promise<Task> {
    return (await this.loadTaskDocument(taskId)).task;
  }

  async createTask(input: Parameters<TaskSystem["createTask"]>[0]): Promise<CreatedTask> {
    await ensureDir(this.taskDir);
    const id = await this.nextTaskId();
    const now = isoNow();
    const branchName = input.mutation.branchName ?? id.toLowerCase();
    const taskPath = path.join(this.taskDir, `${id}.md`);
    const frontmatter: FileTaskFrontmatter = {
      id,
      title: input.mutation.title,
      state: getProviderStateForNormalized(this.config, "ready"),
      priority: input.mutation.priority ?? "none",
      labels: ["Agent"],
      targets: input.mutation.repos.map((repoKey, position) => ({ repoKey, branchName, position })),
      targetDependencies: (input.mutation.repoDependencies ?? []).map((dependency, position) => ({ ...dependency, position })),
      dependsOnTasks: input.mutation.dependencies?.taskIds ?? [],
      baseFromTask: input.mutation.dependencies?.baseTaskId ?? null,
      baseBranch: input.mutation.baseBranch ?? null,
      pullRequests: [],
      runner: null,
      assignee: null,
      createdAt: now,
      updatedAt: now,
    };

    await atomicWriteFile(taskPath, stringifyFileTask(frontmatter, renderTaskCreateDescription(input.mutation)));
    this.logger.info("created file task", { taskId: id, parentTaskId: input.parentTask.id, filePath: taskPath });
    return { id, providerId: id, url: null };
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    const taskPath = path.join(this.taskDir, `${taskId}.md`);
    const commentsPath = fileCommentsPath(taskPath);
    if (!(await pathExists(commentsPath))) {
      return [];
    }
    const raw = await fs.readFile(commentsPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskComment)
      .map((comment) => ({ ...comment, authorKind: normalizeAuthorKind(comment.authorKind) }));
  }

  async addComment(input: { taskId: string; body: string }): Promise<void> {
    const taskPath = path.join(this.taskDir, `${input.taskId}.md`);
    if (!(await pathExists(taskPath))) {
      throw new ForemanError("task_not_found", `Task not found: ${input.taskId}`, 404);
    }

    const comment: TaskComment = {
      id: newId(),
      taskId: input.taskId,
      body: input.body,
      authorName: "agent",
      authorKind: "agent",
      createdAt: isoNow(),
      updatedAt: null,
    };

    await fs.appendFile(fileCommentsPath(taskPath), `${JSON.stringify(comment)}\n`, "utf8");
  }

  async transition(input: { taskId: string; toState: TaskState }): Promise<void> {
    const { task, frontmatter: existingFrontmatter, path: taskPath } = await this.loadTaskDocument(input.taskId);
    const updatedFrontmatter = {
      ...toFileFrontmatter(task, existingFrontmatter.createdAt),
      state: getProviderStateForNormalized(this.config, input.toState),
      updatedAt: isoNow(),
    };
    await atomicWriteFile(taskPath, stringifyFileTask(updatedFrontmatter, task.description));
  }

  async upsertPullRequest(input: { taskId: string; pullRequest: TaskPullRequest }): Promise<void> {
    const { task, frontmatter, path: taskPath } = await this.loadTaskDocument(input.taskId);
    const existingIndex = task.pullRequests.findIndex((pullRequest) => pullRequest.repoKey === input.pullRequest.repoKey);

    if (existingIndex >= 0) {
      task.pullRequests[existingIndex] = { ...task.pullRequests[existingIndex], ...input.pullRequest };
    } else {
      task.pullRequests.push(input.pullRequest);
    }

    await atomicWriteFile(
      taskPath,
      stringifyFileTask(
        {
          ...toFileFrontmatter(task, frontmatter.createdAt),
          pullRequests: task.pullRequests,
          updatedAt: isoNow(),
        },
        task.description,
      ),
    );
  }

  async updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void> {
    const { task, frontmatter, path: taskPath } = await this.loadTaskDocument(input.taskId);
    const labels = new Set(task.labels);
    for (const label of input.remove) {
      labels.delete(label);
    }
    for (const label of input.add) {
      labels.add(label);
    }
    await atomicWriteFile(
      taskPath,
      stringifyFileTask(
        {
          ...toFileFrontmatter(task, frontmatter.createdAt),
          labels: [...labels].sort(),
          updatedAt: isoNow(),
        },
        task.description,
      ),
    );
  }
}
