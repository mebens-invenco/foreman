import type { RepoRef, Task, TaskComment, TaskCreateMutation, TaskPullRequest, TaskState, TaskTargetDependencyRef, TaskTargetRef } from "../../domain/index.js";
import { ForemanError, isForemanError } from "../../lib/errors.js";
import { createTimeoutSignal, isAbortLikeError, PROVIDER_REQUEST_TIMEOUT_MS } from "../../lib/fetch-timeout.js";
import { exec } from "../../lib/process.js";
import { LoggerService } from "../../logger.js";
import type { WorkspaceConfig } from "../../workspace/config.js";
import { parseDotPathRunnerOverride } from "../task-runner-override.js";
import { renderTaskCreateDescription, type CreatedTask, type TaskSystem } from "../task-system.js";
import { getProviderStateForNormalized, normalizeTaskState } from "../task-state-mapping.js";

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

type LinearViewer = {
  id: string;
  name: string;
};

type LinearAssignee = {
  id: string;
  name: string;
};

type LinearIssueCreatePayload = {
  issueCreate: {
    success: boolean;
    issue: {
      id: string;
      identifier: string;
      url: string | null;
    } | null;
  };
};

type RepoDescriptor = { owner: string; repo: string };

const parseCsv = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const uniqueValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
};

const parseRepoDependencies = (value: string): TaskTargetDependencyRef[] => {
  const dependencies: TaskTargetDependencyRef[] = [];
  for (const [position, dependency] of parseCsv(value).entries()) {
    const [taskTargetRepoKey, dependsOnRepoKey] = dependency.split("<-").map((item) => item.trim());
    if (!taskTargetRepoKey || !dependsOnRepoKey) {
      continue;
    }
    dependencies.push({ taskTargetRepoKey, dependsOnRepoKey, position });
  }
  return dependencies;
};

const LINEAR_ISSUE_IDENTIFIER_PATTERN = /([A-Za-z0-9]+-\d+)/;

const parseLinearIssueIdentifier = (taskId: string): { teamKey: string; number: number } | null => {
  const match = taskId.match(/^([A-Za-z0-9]+)-(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    teamKey: match[1]!,
    number: Number.parseInt(match[2]!, 10),
  };
};

const extractLinearIssueIdentifier = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const directIdentifier = parseLinearIssueIdentifier(trimmed);
  if (directIdentifier) {
    return `${directIdentifier.teamKey}-${directIdentifier.number}`;
  }

  const match = trimmed.match(LINEAR_ISSUE_IDENTIFIER_PATTERN);
  return match?.[1] ?? null;
};

const normalizeLinearTaskReference = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const directIdentifier = extractLinearIssueIdentifier(trimmed);
  if (directIdentifier) {
    return directIdentifier;
  }

  const markdownLinkMatch = trimmed.match(/^\[([^\]]+)\]\((.+)\)$/);
  if (!markdownLinkMatch) {
    return trimmed;
  }

  const label = markdownLinkMatch[1] ?? "";
  const target = markdownLinkMatch[2] ?? "";
  return extractLinearIssueIdentifier(label) ?? extractLinearIssueIdentifier(target) ?? trimmed;
};

export const parseLinearMetadata = (
  description: string,
  defaultBranchName?: string,
): Pick<Task, "targets" | "targetDependencies" | "dependencies" | "baseBranch" | "runnerOverride"> => {
  const match = description.match(/(^|\n)Agent:\s*\n((?:\s{2,}.+\n?)*)/i);
  const lines =
    match?.[2]
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

  const taskIds = parseCsv(values.get("depends on tasks") ?? "").map(normalizeLinearTaskReference);
  const baseTaskIdValue = values.get("base from task");
  if (values.has("depends on branches")) {
    throw new ForemanError(
      "invalid_task_metadata",
      "Depends on branches is no longer supported; use task dependencies and repo dependencies instead.",
    );
  }
  const branchName = values.get("branch") ?? null;
  const baseBranch = values.get("base branch") ?? null;
  const effectiveBranchName = branchName ?? defaultBranchName ?? null;
  const repoKeys = uniqueValues(parseCsv(values.get("repos") ?? ""));
  const targetRepoKeys = repoKeys.length > 0 ? repoKeys : uniqueValues(parseCsv(values.get("repo") ?? ""));
  const targets: TaskTargetRef[] = effectiveBranchName
    ? targetRepoKeys.map((repoKey, position) => ({
        repoKey,
        branchName: effectiveBranchName,
        position,
      }))
    : [];

  return {
    targets,
    targetDependencies: values.has("repo dependencies") ? parseRepoDependencies(values.get("repo dependencies") ?? "") : [],
    dependencies: {
      taskIds,
      baseTaskId: baseTaskIdValue ? normalizeLinearTaskReference(baseTaskIdValue) : null,
    },
    baseBranch,
    runnerOverride: parseDotPathRunnerOverride(values),
  };
};

export class LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly logger: LoggerService,
  ) {}

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const startedAt = Date.now();
    const operationName = query.match(/\b(?:query|mutation)\s+(\w+)/)?.[1] ?? "anonymous";
    this.logger.debug("sending Linear GraphQL request", {
      operationName,
      variableKeys: Object.keys(variables).sort().join(","),
    });

    let response: Response;
    try {
      response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: createTimeoutSignal(),
      });
    } catch (error) {
      if (isAbortLikeError(error)) {
        this.logger.error("Linear GraphQL request timed out", {
          operationName,
          durationMs: Date.now() - startedAt,
          timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
        });
        throw new ForemanError("linear_request_timeout", `Linear request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS}ms`, 504);
      }
      throw error;
    }

    if (!response.ok) {
      this.logger.error("Linear GraphQL request failed", {
        operationName,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
      });
      throw new ForemanError("linear_request_failed", `Linear request failed: ${response.status} ${response.statusText}`, 502);
    }

    const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      this.logger.error("Linear GraphQL request returned errors", {
        operationName,
        durationMs: Date.now() - startedAt,
        errorCount: json.errors.length,
        errors: json.errors.map((error) => error.message).join("; "),
      });
      throw new ForemanError(
        "linear_request_failed",
        `Linear request failed: ${json.errors.map((error) => error.message).join("; ")}`,
        502,
      );
    }

    if (!json.data) {
      this.logger.error("Linear GraphQL request returned no data", {
        operationName,
        durationMs: Date.now() - startedAt,
      });
      throw new ForemanError("linear_request_failed", "Linear request returned no data", 502);
    }

    this.logger.debug("Linear GraphQL request completed", {
      operationName,
      durationMs: Date.now() - startedAt,
    });

    return json.data;
  }
}

// Linear's API returns the label "Medium" for priority value 3; "Normal" is retained as a
// legacy synonym so older fixtures and any non-Linear callers still resolve to the same slot.
export const linearPriorityToNormalized = (label: string | null): Task["priority"] => {
  switch ((label ?? "").toLowerCase()) {
    case "urgent":
      return "urgent";
    case "high":
      return "high";
    case "low":
      return "low";
    case "medium":
    case "normal":
      return "normal";
    default:
      return "none";
  }
};

export const normalizedPriorityToLinear = (priority: Task["priority"] | undefined): number => {
  switch (priority ?? "none") {
    case "urgent":
      return 1;
    case "high":
      return 2;
    case "normal":
      return 3;
    case "low":
      return 4;
    case "none":
      return 0;
  }
};

const isGithubPullRequestUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "github.com" || parsed.hostname.endsWith(".github.com")) && /\/pull\/\d+$/.test(parsed.pathname);
  } catch {
    return false;
  }
};

const parseGitHubPullRequestUrl = (url: string): RepoDescriptor & { number: number } => {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new ForemanError("invalid_pr_url", `Invalid GitHub pull request URL: ${url}`);
  }

  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) };
};

const parseGitRemote = (remoteUrl: string): RepoDescriptor => {
  const trimmed = remoteUrl.trim();
  const httpsMatch = trimmed.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }

  throw new ForemanError("unsupported_git_remote", `Unsupported GitHub remote URL: ${remoteUrl}`);
};

const isUnknownProviderStateError = (error: unknown): error is ForemanError =>
  isForemanError(error) && error.code === "unknown_provider_state";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class LinearTaskSystem implements TaskSystem {
  private readonly client: LinearClient;
  private readonly logger: LoggerService;
  private viewerPromise: Promise<LinearViewer> | null = null;
  private teamInfoPromise: Promise<{ id: string; name: string; states: Array<{ id: string; name: string }> }> | null = null;
  private readonly repoDescriptorPromises = new Map<string, Promise<RepoDescriptor>>();

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly env: Record<string, string>,
    private readonly repos: RepoRef[],
    logger?: LoggerService,
  ) {
    this.logger = (logger ?? LoggerService.create({ context: { component: "taskSystem.linear" }, colorMode: "never" })).child({
      component: "taskSystem.linear",
    });
    const apiKey = env.LINEAR_API_KEY;
    if (!apiKey) {
      this.logger.error("Linear task system initialization failed because LINEAR_API_KEY is missing");
      throw new ForemanError("missing_linear_api_key", "LINEAR_API_KEY is required for Linear workspaces", 400);
    }

    this.client = new LinearClient(apiKey, this.logger.child({ component: "taskSystem.linear.client" }));
  }

  getProvider(): "linear" {
    return "linear";
  }

  private async repoDescriptorFromRepo(repo: RepoRef): Promise<RepoDescriptor> {
    let promise = this.repoDescriptorPromises.get(repo.rootPath);
    if (!promise) {
      promise = exec("git", ["config", "--get", "remote.origin.url"], { cwd: repo.rootPath }).then((result) =>
        parseGitRemote(result.stdout),
      );
      this.repoDescriptorPromises.set(repo.rootPath, promise);
    }

    return promise;
  }

  private async resolveRepoKeyForPullRequest(url: string): Promise<string | null> {
    if (!isGithubPullRequestUrl(url)) {
      return null;
    }

    const parsed = parseGitHubPullRequestUrl(url);
    for (const repo of this.repos) {
      try {
        const descriptor = await this.repoDescriptorFromRepo(repo);
        if (descriptor.owner === parsed.owner && descriptor.repo === parsed.repo) {
          return repo.key;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async resolvePullRequests(
    attachments: LinearIssueNode["attachments"]["nodes"],
    targets: TaskTargetRef[],
  ): Promise<TaskPullRequest[]> {
    const uniqueByRepoKey = new Map<string, TaskPullRequest>();

    for (const attachment of attachments) {
      if (!isGithubPullRequestUrl(attachment.url)) {
        continue;
      }

      const resolvedRepoKey = await this.resolveRepoKeyForPullRequest(attachment.url);
      if (resolvedRepoKey && targets.some((target) => target.repoKey === resolvedRepoKey)) {
        uniqueByRepoKey.set(resolvedRepoKey, {
          repoKey: resolvedRepoKey,
          url: attachment.url,
          ...(attachment.title ? { title: attachment.title } : {}),
          source: "provider",
        });
        continue;
      }

      if (targets.length === 1) {
        uniqueByRepoKey.set(targets[0]!.repoKey, {
          repoKey: targets[0]!.repoKey,
          url: attachment.url,
          ...(attachment.title ? { title: attachment.title } : {}),
          source: "provider_inferred",
        });
      }
    }

    return [...uniqueByRepoKey.values()];
  }

  private async linearIssueToTask(node: LinearIssueNode): Promise<Task> {
    const metadata = parseLinearMetadata(node.description ?? "", node.branchName ?? node.identifier.toLowerCase());
    return {
      id: node.identifier,
      provider: "linear",
      providerId: node.id,
      title: node.title,
      description: node.description ?? "",
      state: normalizeTaskState(this.config, node.state.name),
      providerState: node.state.name,
      priority: linearPriorityToNormalized(node.priorityLabel),
      labels: node.labels.nodes.map((label) => label.name),
      assignee: node.assignee?.name ?? null,
      targets: metadata.targets,
      targetDependencies: metadata.targetDependencies,
      dependencies: metadata.dependencies,
      baseBranch: metadata.baseBranch,
      pullRequests: await this.resolvePullRequests(node.attachments.nodes, metadata.targets),
      runnerOverride: metadata.runnerOverride,
      updatedAt: node.updatedAt,
      url: node.url,
    };
  }

  private async fetchIssueNode(taskId: string): Promise<LinearIssueNode> {
    const identifier = parseLinearIssueIdentifier(taskId);

    const data = await this.client.request<{ issues: { nodes: LinearIssueNode[] } }>(
      identifier
        ? `query ForemanIssue($teamKey: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
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
      }`
        : `query ForemanIssue($id: ID!) {
        issues(filter: { id: { eq: $id } }, first: 1) {
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
      identifier ? { teamKey: identifier.teamKey, number: identifier.number } : { id: taskId },
    );

    const issue = data.issues.nodes[0];
    if (!issue) {
      this.logger.error("Linear issue was not found", { taskId });
      throw new ForemanError("task_not_found", `Linear task not found: ${taskId}`, 404);
    }

    return issue;
  }

  private async getViewer(): Promise<LinearViewer> {
    if (!this.viewerPromise) {
      this.viewerPromise = this.client
        .request<{ viewer: LinearViewer }>(
          `query ForemanViewer {
            viewer {
              id
              name
            }
          }`,
        )
        .then((data) => data.viewer);
    }

    return this.viewerPromise;
  }

  private async getConfiguredTeamInfo(): Promise<{ id: string; name: string; states: Array<{ id: string; name: string }> }> {
    if (!this.teamInfoPromise) {
      const teamName = this.config.taskSystem.linear!.team;
      this.teamInfoPromise = this.client
        .request<{
          teams: { nodes: Array<{ id: string; name: string; states: { nodes: Array<{ id: string; name: string }> } }> };
        }>(
          `query ForemanTeamInfo($teamName: String!) {
            teams(filter: { name: { eq: $teamName } }) {
              nodes {
                id
                name
                states { nodes { id name } }
              }
            }
          }`,
          { teamName },
        )
        .then((data) => {
          const team = data.teams.nodes.find((item) => item.name === teamName);
          if (!team) {
            this.logger.error("Linear startup validation failed because the configured team was not found", { team: teamName });
            throw new ForemanError("linear_team_not_found", `Linear team not found: ${teamName}`);
          }

          return {
            id: team.id,
            name: team.name,
            states: team.states.nodes,
          };
        });
    }

    return this.teamInfoPromise;
  }

  private async resolveAssigneeFilter(): Promise<{ assigneeId?: string; assigneeName?: string }> {
    const assignee = this.config.taskSystem.linear!.assignee;
    if (assignee !== "me") {
      return { assigneeName: assignee };
    }

    const viewer = await this.getViewer();
    this.logger.debug("resolved Linear assignee from API token", {
      configuredAssignee: assignee,
      resolvedAssigneeId: viewer.id,
      resolvedAssigneeName: viewer.name,
    });
    return { assigneeId: viewer.id };
  }

  private async resolveIssueCreateAssigneeId(): Promise<string> {
    const assignee = this.config.taskSystem.linear!.assignee;
    if (assignee === "me") {
      return (await this.getViewer()).id;
    }

    const data = await this.client.request<{ users: { nodes: LinearAssignee[] } }>(
      `query ForemanAssigneeByName($name: String!) {
        users(filter: { name: { eq: $name } }, first: 1) {
          nodes { id name }
        }
      }`,
      { name: assignee },
    );
    const user = data.users.nodes.find((item) => item.name === assignee);
    if (!user) {
      this.logger.error("Linear assignee was not found for task creation", { assignee });
      throw new ForemanError("linear_assignee_not_found", `Linear assignee not found: ${assignee}`);
    }
    return user.id;
  }

  async validateStartup(): Promise<void> {
    const linear = this.config.taskSystem.linear!;
    this.logger.info("validating Linear startup configuration", { team: linear.team });
    try {
      const team = await this.getConfiguredTeamInfo();
      const response = await this.client.request<{
        issueLabels: { nodes: Array<{ id: string; name: string }> };
      }>(
        `query ValidateForemanStartup {
          issueLabels(first: 250) {
            nodes { id name }
          }
        }`,
        {},
      );

      const configuredStates = uniqueValues([
        ...linear.states.ready,
        ...linear.states.inProgress,
        ...linear.states.inReview,
        ...linear.states.deployable,
        ...linear.states.done,
        ...linear.states.canceled,
      ]);
      const availableStates = new Set(team.states.map((state) => state.name));
      const missingStates = configuredStates.filter((state) => !availableStates.has(state));
      if (missingStates.length > 0) {
        this.logger.error("Linear startup validation failed because configured states were not found", {
          states: missingStates.join(", "),
          team: linear.team,
        });
        throw new ForemanError("linear_state_not_found", `Configured Linear states not found: ${missingStates.join(", ")}`);
      }

      const requiredLabels = uniqueValues([...linear.includeLabels, linear.agentCreatedLabel, linear.consolidatedLabel]);
      const availableLabels = new Set(response.issueLabels.nodes.map((label) => label.name));
      const missingLabels = requiredLabels.filter((label) => !availableLabels.has(label));
      if (missingLabels.length > 0) {
        this.logger.error("Linear startup validation failed because configured labels were not found", {
          labels: missingLabels.join(", "),
          team: linear.team,
        });
        throw new ForemanError("linear_label_not_found", `Configured Linear labels not found: ${missingLabels.join(", ")}`);
      }

      let resolvedAssignee: { id: string; name: string } | null = null;
      if (linear.assignee === "me") {
        resolvedAssignee = await this.getViewer();
      }

      this.logger.info("validated Linear startup configuration", {
        team: linear.team,
        assignee: linear.assignee,
        resolvedAssigneeId: resolvedAssignee?.id,
        resolvedAssigneeName: resolvedAssignee?.name,
        configuredStateCount: configuredStates.length,
        requiredLabelCount: requiredLabels.length,
        availableTeamStateCount: team.states.length,
        availableLabelCount: response.issueLabels.nodes.length,
      });
    } catch (error) {
      if (!(error instanceof ForemanError)) {
        this.logger.error("Linear startup validation failed", { error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  async listCandidates(): Promise<Task[]> {
    const linear = this.config.taskSystem.linear!;
    const assigneeFilter = await this.resolveAssigneeFilter();
    this.logger.debug("listing Linear candidate issues", {
      team: linear.team,
      assignee: assigneeFilter.assigneeName ?? assigneeFilter.assigneeId,
      labelCount: linear.includeLabels.length,
    });
    const data = await this.client.request<{ issues: { nodes: LinearIssueNode[] } }>(
      assigneeFilter.assigneeId
        ? `query ForemanIssueCandidates($teamName: String!, $labels: [String!], $assigneeId: ID!) {
        issues(
          filter: {
            team: { name: { eq: $teamName } },
            assignee: { id: { eq: $assigneeId } },
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
      }`
        : `query ForemanIssueCandidates($teamName: String!, $labels: [String!], $assigneeName: String!) {
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
      {
        teamName: linear.team,
        labels: linear.includeLabels,
        ...(assigneeFilter.assigneeId ? { assigneeId: assigneeFilter.assigneeId } : { assigneeName: assigneeFilter.assigneeName! }),
      },
    );

    const mappedTasks = await Promise.all(
      data.issues.nodes.map(async (node) => {
        try {
          return await this.linearIssueToTask(node);
        } catch (error) {
          if (!isUnknownProviderStateError(error)) {
            throw error;
          }

          this.logger.info("skipping Linear candidate with unmapped provider state", {
            provider: "linear",
            taskId: node.identifier,
            providerId: node.id,
            providerState: node.state.name,
          });
          return null;
        }
      }),
    );
    const tasks = mappedTasks.flatMap((task) => (task ? [task] : []));

    this.logger.debug("listed Linear candidate issues", {
      count: data.issues.nodes.length,
      acceptedCount: tasks.length,
      skippedCount: data.issues.nodes.length - tasks.length,
    });
    return tasks;
  }

  async getTask(taskId: string): Promise<Task> {
    this.logger.debug("fetching Linear issue", { taskId });
    const issue = await this.fetchIssueNode(taskId);
    this.logger.debug("fetched Linear issue", { taskId, providerId: issue.id, state: issue.state.name });
    return this.linearIssueToTask(issue);
  }

  private async resolveReadyStateId(): Promise<string> {
    const linear = this.config.taskSystem.linear!;
    const team = await this.getConfiguredTeamInfo();
    const state = linear.states.ready.map((name) => team.states.find((item) => item.name === name)).find(Boolean);
    if (!state) {
      this.logger.error("Linear ready state was not found for task creation", { team: linear.team, readyStates: linear.states.ready.join(",") });
      throw new ForemanError("linear_state_not_found", `Linear ready state not found: ${linear.states.ready.join(", ")}`);
    }
    return state.id;
  }

  private async resolveLabelIds(labelNames: string[]): Promise<string[]> {
    const labelData = await this.client.request<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
      `query ForemanLabels {
        issueLabels(first: 250) { nodes { id name } }
      }`,
    );
    const labelsByName = new Map(labelData.issueLabels.nodes.map((label) => [label.name, label.id]));
    const labelIds: string[] = [];
    for (const name of uniqueValues(labelNames)) {
      const id = labelsByName.get(name);
      if (!id) {
        this.logger.error("Linear label was not found for task creation", { label: name });
        throw new ForemanError("linear_label_not_found", `Linear label not found: ${name}`);
      }
      labelIds.push(id);
    }
    return labelIds;
  }

  async createTask(input: { parentTask: Task; mutation: TaskCreateMutation }): Promise<CreatedTask> {
    const linear = this.config.taskSystem.linear!;
    const team = await this.getConfiguredTeamInfo();
    const stateId = await this.resolveReadyStateId();
    const labelIds = await this.resolveLabelIds([...linear.includeLabels, linear.agentCreatedLabel]);
    const assigneeId = await this.resolveIssueCreateAssigneeId();
    const variables = {
      input: {
        teamId: team.id,
        parentId: input.parentTask.providerId,
        title: input.mutation.title,
        description: renderTaskCreateDescription(input.mutation),
        stateId,
        labelIds,
        priority: normalizedPriorityToLinear(input.mutation.priority),
        assigneeId,
      },
    };

    this.logger.info("creating Linear child issue", {
      parentTaskId: input.parentTask.id,
      parentProviderId: input.parentTask.providerId,
      title: input.mutation.title,
      repoCount: input.mutation.repos.length,
      labelCount: labelIds.length,
    });
    const data = await this.client.request<LinearIssueCreatePayload>(
      `mutation ForemanIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      variables,
    );
    if (!data.issueCreate.issue) {
      throw new ForemanError("linear_request_failed", "Linear issueCreate returned no issue", 502);
    }
    this.logger.info("created Linear child issue", {
      parentTaskId: input.parentTask.id,
      createdTaskId: data.issueCreate.issue.identifier,
      createdProviderId: data.issueCreate.issue.id,
      url: data.issueCreate.issue.url,
    });
    return {
      id: data.issueCreate.issue.identifier,
      providerId: data.issueCreate.issue.id,
      url: data.issueCreate.issue.url,
    };
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    this.logger.debug("listing Linear issue comments", { taskId });
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
      this.logger.error("Linear issue was not found while listing comments", { taskId, providerId: task.providerId });
      throw new ForemanError("task_not_found", `Linear task not found: ${taskId}`, 404);
    }

    const comments: TaskComment[] = data.issue.comments.nodes.map((comment) => ({
      id: comment.id,
      taskId,
      body: comment.body,
      authorName: comment.user?.name ?? null,
      authorKind: comment.user?.name ? (comment.body.startsWith(this.config.workspace.agentPrefix) ? "agent" : "human") : "unknown",
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }));

    this.logger.debug("listed Linear issue comments", { taskId, providerId: task.providerId, count: comments.length });
    return comments;
  }

  async addComment(input: { taskId: string; body: string }): Promise<void> {
    const task = await this.getTask(input.taskId);
    this.logger.info("adding Linear issue comment", { taskId: input.taskId, providerId: task.providerId, bodyLength: input.body.length });
    await this.client.request(
      `mutation ForemanIssueCommentCreate($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }`,
      { issueId: task.providerId, body: input.body },
    );
    this.logger.info("added Linear issue comment", { taskId: input.taskId, providerId: task.providerId });
  }

  async transition(input: { taskId: string; toState: TaskState }): Promise<void> {
    const task = await this.getTask(input.taskId);
    const providerState = getProviderStateForNormalized(this.config, input.toState);
    this.logger.info("transitioning Linear issue", {
      taskId: input.taskId,
      providerId: task.providerId,
      toState: input.toState,
      providerState,
    });
    const team = await this.getConfiguredTeamInfo();
    const target = team.states.find((state) => state.name === providerState);
    if (!target) {
      this.logger.error("Linear workflow state was not found for transition", { taskId: input.taskId, providerState });
      throw new ForemanError("linear_state_not_found", `Linear state not found: ${providerState}`);
    }

    await this.client.request(
      `mutation ForemanIssueUpdate($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: task.providerId, stateId: target.id },
    );
    this.logger.info("transitioned Linear issue", { taskId: input.taskId, providerId: task.providerId, stateId: target.id, providerState });
  }

  async upsertPullRequest(input: { taskId: string; pullRequest: TaskPullRequest }): Promise<void> {
    const { pullRequest } = input;
    if (!isGithubPullRequestUrl(pullRequest.url)) {
      this.logger.info("skipping non-GitHub pull request attachment for Linear issue", {
        taskId: input.taskId,
        repoKey: pullRequest.repoKey,
        pullRequestUrl: pullRequest.url,
        source: pullRequest.source,
      });
      return;
    }

    let issue: LinearIssueNode;
    try {
      issue = await this.fetchIssueNode(input.taskId);
    } catch (error) {
      this.logger.warn("failed to sync Linear pull request attachment", {
        taskId: input.taskId,
        repoKey: pullRequest.repoKey,
        pullRequestUrl: pullRequest.url,
        source: pullRequest.source,
        error: errorMessage(error),
      });
      return;
    }

    if (issue.attachments.nodes.some((attachment) => attachment.url === pullRequest.url)) {
      this.logger.info("skipping duplicate Linear pull request attachment", {
        taskId: input.taskId,
        providerId: issue.id,
        repoKey: pullRequest.repoKey,
        pullRequestUrl: pullRequest.url,
        source: pullRequest.source,
      });
      return;
    }

    try {
      await this.client.request(
        `mutation ForemanPullRequestAttachmentCreate($issueId: String!, $title: String!, $url: String!) {
          attachmentCreate(input: { issueId: $issueId, title: $title, url: $url }) { success }
        }`,
        {
          issueId: issue.id,
          title: pullRequest.title ?? pullRequest.url,
          url: pullRequest.url,
        },
      );
      this.logger.info("created Linear pull request attachment", {
        taskId: input.taskId,
        providerId: issue.id,
        repoKey: pullRequest.repoKey,
        pullRequestUrl: pullRequest.url,
        source: pullRequest.source,
      });
    } catch (error) {
      this.logger.warn("failed to create Linear pull request attachment", {
        taskId: input.taskId,
        providerId: issue.id,
        repoKey: pullRequest.repoKey,
        pullRequestUrl: pullRequest.url,
        source: pullRequest.source,
        error: errorMessage(error),
      });
    }
  }

  async updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void> {
    const task = await this.getTask(input.taskId);
    this.logger.info("updating Linear issue labels", {
      taskId: input.taskId,
      providerId: task.providerId,
      addCount: input.add.length,
      removeCount: input.remove.length,
    });
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
    this.logger.info("updated Linear issue labels", {
      taskId: input.taskId,
      providerId: task.providerId,
      finalLabelCount: labelIds.length,
    });
  }
}
