import { promises as fs } from "node:fs";
import path from "node:path";

import fg from "fast-glob";
import matter from "gray-matter";
import YAML from "yaml";

import type { WorkspaceConfig, WorkspacePaths } from "./config.js";
import type { Task, TaskArtifact, TaskComment, TaskProvider, TaskState } from "./domain.js";
import { ForemanError } from "./lib/errors.js";
import { atomicWriteFile, ensureDir, pathExists } from "./lib/fs.js";
import { newId } from "./lib/ids.js";
import { isoNow } from "./lib/time.js";

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

const normalizedStateMap = (config: WorkspaceConfig): Record<string, TaskState> => {
  if (config.taskSystem.type === "linear") {
    const states = config.taskSystem.linear!.states;
    return Object.fromEntries([
      ...states.ready.map((value) => [value, "ready"]),
      ...states.inProgress.map((value) => [value, "in_progress"]),
      ...states.inReview.map((value) => [value, "in_review"]),
      ...states.done.map((value) => [value, "done"]),
      ...states.canceled.map((value) => [value, "canceled"]),
    ]);
  }

  const states = config.taskSystem.file!.states;
  return Object.fromEntries([
    ...states.ready.map((value) => [value, "ready"]),
    ...states.inProgress.map((value) => [value, "in_progress"]),
    ...states.inReview.map((value) => [value, "in_review"]),
    ...states.done.map((value) => [value, "done"]),
    ...states.canceled.map((value) => [value, "canceled"]),
  ]);
};

export const normalizeTaskState = (config: WorkspaceConfig, providerState: string): TaskState => {
  const mapped = normalizedStateMap(config)[providerState];
  if (!mapped) {
    throw new ForemanError("unknown_provider_state", `Unmapped provider state: ${providerState}`);
  }
  return mapped;
};

export const getProviderStateForNormalized = (config: WorkspaceConfig, state: TaskState): string => {
  const stateConfig = config.taskSystem.type === "linear" ? config.taskSystem.linear!.states : config.taskSystem.file!.states;
  switch (state) {
    case "ready":
      return stateConfig.ready[0]!;
    case "in_progress":
      return stateConfig.inProgress[0]!;
    case "in_review":
      return stateConfig.inReview[0]!;
    case "done":
      return stateConfig.done[0]!;
    case "canceled":
      return stateConfig.canceled[0]!;
  }
};

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

const parseCsv = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const parseLinearMetadata = (description: string): Pick<Task, "repo" | "branchName" | "dependencies"> => {
  const match = description.match(/(^|\n)Foreman:\s*\n((?:\s{2,}.+\n?)*)/i);
  const lines = match?.[2]
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean) ?? [];

  const values = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    values.set(key, value);
  }

  const taskIds = parseCsv(values.get("depends on tasks") ?? "");
  const baseTaskId = values.get("base from task") ?? null;
  return {
    repo: values.get("repo") ?? null,
    branchName: values.get("branch") ?? null,
    dependencies: {
      taskIds,
      baseTaskId,
      branchNames: parseCsv(values.get("depends on branches") ?? ""),
    },
  };
};

type FileTaskFrontmatter = {
  id: string;
  title: string;
  state: string;
  priority: string;
  labels?: string[];
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

const parseFileTaskDocument = (config: WorkspaceConfig, filePath: string, contents: string): Task => {
  const parsed = matter(contents);
  const data = parsed.data as FileTaskFrontmatter;
  const stem = path.basename(filePath, ".md");
  if (data.id !== stem) {
    throw new ForemanError("invalid_file_task", `Task id ${data.id} does not match filename ${stem}`);
  }

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
    repo: data.repo ?? null,
    branchName: data.branchName ?? data.id.toLowerCase(),
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

const toFileFrontmatter = (task: Task, createdAt: string): FileTaskFrontmatter => ({
  id: task.id,
  title: task.title,
  state: task.providerState,
  priority: task.priority,
  labels: task.labels,
  repo: task.repo,
  branchName: task.branchName ?? task.id.toLowerCase(),
  dependsOnTasks: task.dependencies.taskIds,
  baseFromTask: task.dependencies.baseTaskId,
  dependsOnBranches: task.dependencies.branchNames,
  artifacts: task.artifacts,
  assignee: task.assignee,
  createdAt,
  updatedAt: task.updatedAt,
});

const fileCommentsPath = (taskPath: string): string => taskPath.replace(/\.md$/, ".comments.ndjson");

export class FileTaskSystem implements TaskSystem {
  constructor(
    private readonly config: WorkspaceConfig,
    private readonly paths: WorkspacePaths,
  ) {}

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
    return Promise.all(files.map(async (filePath) => parseFileTaskDocument(this.config, filePath, await fs.readFile(filePath, "utf8"))));
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

type LinearIssueNode = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { id: string; name: string };
  priorityLabel: string | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  assignee: { name: string } | null;
  branchName: string | null;
  updatedAt: string;
  url: string | null;
  attachments: { nodes: Array<{ id: string; title: string | null; url: string }> };
};

class LinearClient {
  constructor(private readonly apiKey: string) {}

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new ForemanError("linear_request_failed", `Linear request failed: ${response.status} ${response.statusText}`, 502);
    }

    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new ForemanError(
        "linear_request_failed",
        `Linear request failed: ${json.errors.map((error) => error.message).join("; ")}`,
        502,
      );
    }

    if (!json.data) {
      throw new ForemanError("linear_request_failed", "Linear request returned no data", 502);
    }

    return json.data;
  }
}

const linearPriorityToNormalized = (label: string | null): Task["priority"] => {
  switch ((label ?? "").toLowerCase()) {
    case "urgent":
      return "urgent";
    case "high":
      return "high";
    case "low":
      return "low";
    case "normal":
      return "normal";
    default:
      return "none";
  }
};

const linearIssueToTask = (config: WorkspaceConfig, node: LinearIssueNode): Task => {
  const metadata = parseLinearMetadata(node.description ?? "");
  const branchName = metadata.branchName ?? node.branchName ?? node.identifier.toLowerCase();
  return {
    id: node.identifier,
    provider: "linear",
    providerId: node.id,
    title: node.title,
    description: node.description ?? "",
    state: normalizeTaskState(config, node.state.name),
    providerState: node.state.name,
    priority: linearPriorityToNormalized(node.priorityLabel),
    labels: node.labels.nodes.map((label) => label.name),
    assignee: node.assignee?.name ?? null,
    repo: metadata.repo,
    branchName,
    dependencies: metadata.dependencies,
    artifacts: node.attachments.nodes.map((attachment) => ({
      type: attachment.url.includes("/pull/") ? "pull_request" : "link",
      url: attachment.url,
      ...(attachment.title ? { title: attachment.title } : {}),
      externalId: attachment.id,
    })),
    updatedAt: node.updatedAt,
    url: node.url,
  };
};

export class LinearTaskSystem implements TaskSystem {
  private readonly client: LinearClient;

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly env: Record<string, string>,
  ) {
    const apiKey = env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new ForemanError("missing_linear_api_key", "LINEAR_API_KEY is required for Linear workspaces", 400);
    }

    this.client = new LinearClient(apiKey);
  }

  getProvider(): "linear" {
    return "linear";
  }

  async validateStartup(): Promise<void> {
    const linear = this.config.taskSystem.linear!;
    const response = await this.client.request<{
      teams: { nodes: Array<{ id: string; name: string; states: { nodes: Array<{ id: string; name: string }> } }> };
      issueLabels: { nodes: Array<{ id: string; name: string }> };
    }>(
      `query ValidateForemanStartup($teamName: String!) {
        teams(filter: { name: { eq: $teamName } }) {
          nodes {
            id
            name
            states { nodes { id name } }
          }
        }
        issueLabels {
          nodes { id name }
        }
      }`,
      { teamName: linear.team },
    );

    const team = response.teams.nodes.find((item) => item.name === linear.team);
    if (!team) {
      throw new ForemanError("linear_team_not_found", `Linear team not found: ${linear.team}`);
    }

    const configuredStates = [
      ...linear.states.ready,
      ...linear.states.inProgress,
      ...linear.states.inReview,
      ...linear.states.done,
      ...linear.states.canceled,
    ];
    const availableStates = new Set(team.states.nodes.map((state) => state.name));
    for (const state of configuredStates) {
      if (!availableStates.has(state)) {
        throw new ForemanError("linear_state_not_found", `Configured Linear state not found: ${state}`);
      }
    }

    const availableLabels = new Set(response.issueLabels.nodes.map((label) => label.name));
    for (const label of [...linear.includeLabels, linear.consolidatedLabel]) {
      if (!availableLabels.has(label)) {
        throw new ForemanError("linear_label_not_found", `Configured Linear label not found: ${label}`);
      }
    }
  }

  async listCandidates(): Promise<Task[]> {
    const linear = this.config.taskSystem.linear!;
    const data = await this.client.request<{ issues: { nodes: LinearIssueNode[] } }>(
      `query ForemanIssueCandidates($teamName: String!, $labels: [String!], $assigneeName: String!) {
        issues(
          filter: {
            team: { name: { eq: $teamName } },
            assignee: { name: { eq: $assigneeName } },
            labels: { some: { name: { in: $labels } } }
          },
          first: 250
        ) {
          nodes {
            id
            identifier
            title
            description
            branchName
            updatedAt
            url
            priorityLabel
            state { id name }
            assignee { name }
            labels { nodes { id name } }
            attachments { nodes { id title url } }
          }
        }
      }`,
      { teamName: linear.team, labels: linear.includeLabels, assigneeName: linear.assignee },
    );

    return data.issues.nodes.map((node) => linearIssueToTask(this.config, node));
  }

  async getTask(taskId: string): Promise<Task> {
    const data = await this.client.request<{ issues: { nodes: LinearIssueNode[] } }>(
      `query ForemanIssue($identifier: String!) {
        issues(filter: { identifier: { eq: $identifier } }, first: 1) {
          nodes {
            id
            identifier
            title
            description
            branchName
            updatedAt
            url
            priorityLabel
            state { id name }
            assignee { name }
            labels { nodes { id name } }
            attachments { nodes { id title url } }
          }
        }
      }`,
      { identifier: taskId },
    );

    const issue = data.issues.nodes[0];
    if (!issue) {
      throw new ForemanError("task_not_found", `Linear task not found: ${taskId}`, 404);
    }

    return linearIssueToTask(this.config, issue);
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    const task = await this.getTask(taskId);
    const data = await this.client.request<{
      issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string; updatedAt: string | null; user: { name: string } | null }> } } | null;
    }>(
      `query ForemanIssueComments($id: String!) {
        issue(id: $id) {
          comments(first: 250) {
            nodes {
              id
              body
              createdAt
              updatedAt
              user { name }
            }
          }
        }
      }`,
      { id: task.providerId },
    );

    if (!data.issue) {
      throw new ForemanError("task_not_found", `Linear task not found: ${taskId}`, 404);
    }

    return data.issue.comments.nodes.map((comment) => ({
      id: comment.id,
      taskId,
      body: comment.body,
      authorName: comment.user?.name ?? null,
      authorKind: comment.user?.name ? (comment.body.startsWith(this.config.workspace.agentPrefix) ? "agent" : "human") : "unknown",
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }));
  }

  async addComment(input: { taskId: string; body: string }): Promise<void> {
    const task = await this.getTask(input.taskId);
    await this.client.request(
      `mutation ForemanIssueCommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId: task.providerId, body: input.body },
    );
  }

  async transition(input: { taskId: string; toState: TaskState }): Promise<void> {
    const task = await this.getTask(input.taskId);
    const providerState = getProviderStateForNormalized(this.config, input.toState);
    const teamData = await this.client.request<{
      workflowStates: { nodes: Array<{ id: string; name: string }> };
    }>(
      `query ForemanWorkflowStates {
        workflowStates(first: 250) { nodes { id name } }
      }`,
    );
    const target = teamData.workflowStates.nodes.find((state) => state.name === providerState);
    if (!target) {
      throw new ForemanError("linear_state_not_found", `Linear state not found: ${providerState}`);
    }

    await this.client.request(
      `mutation ForemanIssueUpdate($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: task.providerId, stateId: target.id },
    );
  }

  async addArtifact(input: { taskId: string; artifact: TaskArtifact }): Promise<void> {
    const task = await this.getTask(input.taskId);
    const existingArtifact = task.artifacts.find(
      (artifact) => artifact.type === input.artifact.type && artifact.url === input.artifact.url,
    );

    if (existingArtifact?.externalId) {
      await this.client.request(
        `mutation ForemanAttachmentUpdate($id: String!, $title: String) {
          attachmentUpdate(id: $id, input: { title: $title }) { success }
        }`,
        { id: existingArtifact.externalId, title: input.artifact.title ?? existingArtifact.title ?? null },
      );
      return;
    }

    await this.client.request(
      `mutation ForemanAttachmentCreate($issueId: String!, $url: String!, $title: String) {
        attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success }
      }`,
      { issueId: task.providerId, url: input.artifact.url, title: input.artifact.title ?? null },
    );
  }

  async updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void> {
    const task = await this.getTask(input.taskId);
    const labelData = await this.client.request<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
      `query ForemanLabels {
        issueLabels(first: 250) { nodes { id name } }
      }`,
    );

    const desired = new Set(task.labels);
    for (const value of input.remove) {
      desired.delete(value);
    }
    for (const value of input.add) {
      desired.add(value);
    }

    const labelIds = labelData.issueLabels.nodes.filter((label) => desired.has(label.name)).map((label) => label.id);
    await this.client.request(
      `mutation ForemanIssueLabels($id: String!, $labelIds: [String!]) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
      }`,
      { id: task.providerId, labelIds },
    );
  }
}

export const createTaskSystem = (input: {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  env: Record<string, string>;
}): TaskSystem => {
  if (input.config.taskSystem.type === "file") {
    return new FileTaskSystem(input.config, input.paths);
  }

  return new LinearTaskSystem(input.config, input.env);
};
