import { promises as fs } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import YAML from "yaml";

import {
  getTaskTargetRefsFromTask,
  type Task,
  type TaskArtifact,
  type TaskComment,
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
import type { TaskSystem } from "../task-system.js";
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
  dependsOnBranches?: string[];
  artifacts?: TaskArtifact[];
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
  "repo",
  "branchName",
  "dependsOnTasks",
  "baseFromTask",
  "dependsOnBranches",
  "artifacts",
  "assignee",
  "createdAt",
  "updatedAt",
];

const stringifyFileTask = (frontmatter: FileTaskFrontmatter, body: string): string => {
  const ordered = Object.fromEntries(fileFrontmatterOrder.map((key) => [key, frontmatter[key]]));
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

const deriveLegacyRepoFields = (targets: TaskTargetRef[]): { repo: string | null; branchName: string | null } => {
  const primaryTarget = targets.length === 1 ? targets[0] : null;
  return {
    repo: primaryTarget ? primaryTarget.repoKey : null,
    branchName: primaryTarget ? primaryTarget.branchName : null,
  };
};

const parseFileTaskDocument = (config: WorkspaceConfig, filePath: string, contents: string): Task => {
  const parsed = matter(contents);
  const data = parsed.data as FileTaskFrontmatter;
  const stem = path.basename(filePath, ".md");
  if (data.id !== stem) {
    throw new ForemanError("invalid_file_task", `Task id ${data.id} does not match filename ${stem}`);
  }

  const targets = normalizeTaskTargets(data);
  const targetDependencies = normalizeTargetDependencies(data);
  const { repo, branchName } = deriveLegacyRepoFields(targets);

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
    repo,
    branchName,
    targets,
    targetDependencies,
    dependencies: {
      taskIds: data.dependsOnTasks ?? [],
      baseTaskId: data.baseFromTask ?? null,
      branchNames: data.dependsOnBranches ?? [],
    },
    artifacts: data.artifacts ?? [],
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
    ...deriveLegacyRepoFields(targets),
    dependsOnTasks: task.dependencies.taskIds,
    baseFromTask: task.dependencies.baseTaskId,
    dependsOnBranches: task.dependencies.branchNames,
    artifacts: task.artifacts,
    assignee: task.assignee,
    createdAt,
    updatedAt: task.updatedAt,
  };
};

const fileCommentsPath = (taskPath: string): string => taskPath.replace(/\.md$/, ".comments.ndjson");

const isUnknownProviderStateError = (error: unknown): error is ForemanError =>
  isForemanError(error) && error.code === "unknown_provider_state";

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

  async addArtifact(input: { taskId: string; artifact: TaskArtifact }): Promise<void> {
    const { task, frontmatter, path: taskPath } = await this.loadTaskDocument(input.taskId);
    const existingIndex = task.artifacts.findIndex(
      (artifact) => artifact.type === input.artifact.type && artifact.url === input.artifact.url,
    );

    if (existingIndex >= 0) {
      task.artifacts[existingIndex] = { ...task.artifacts[existingIndex], ...input.artifact };
    } else {
      task.artifacts.push(input.artifact);
    }

    await atomicWriteFile(
      taskPath,
      stringifyFileTask(
        {
          ...toFileFrontmatter(task, frontmatter.createdAt),
          artifacts: task.artifacts,
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
