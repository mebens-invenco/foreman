import type { Task, TaskArtifact, TaskComment, TaskState, TaskTargetDependencyRef, TaskTargetRef } from "../../domain/index.js";
import { ForemanError, isForemanError } from "../../lib/errors.js";
import { LoggerService } from "../../logger.js";
import type { WorkspaceConfig } from "../../workspace/config.js";
import type { TaskSystem } from "../task-system.js";
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
): Pick<Task, "repo" | "branchName" | "targets" | "targetDependencies" | "dependencies"> => {
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
  const branchName = values.get("branch") ?? null;
  const effectiveBranchName = branchName ?? defaultBranchName ?? null;
  const repoKeys = uniqueValues(parseCsv(values.get("repos") ?? ""));
  const targetRepoKeys = repoKeys.length > 0 ? repoKeys : uniqueValues(parseCsv(values.get("repo") ?? ""));
  const primaryRepoKey = targetRepoKeys.length === 1 ? targetRepoKeys[0]! : null;
  const targets: TaskTargetRef[] = effectiveBranchName
    ? targetRepoKeys.map((repoKey, position) => ({
        repoKey,
        branchName: effectiveBranchName,
        position,
      }))
    : [];

  return {
    repo: primaryRepoKey,
    branchName: effectiveBranchName,
    targets,
    targetDependencies: values.has("repo dependencies") ? parseRepoDependencies(values.get("repo dependencies") ?? "") : [],
    dependencies: {
      taskIds,
      baseTaskId: baseTaskIdValue ? normalizeLinearTaskReference(baseTaskIdValue) : null,
      branchNames: parseCsv(values.get("depends on branches") ?? ""),
    },
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

    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

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

const isGithubPullRequestArtifact = (artifact: Pick<TaskArtifact, "type" | "url">): boolean => {
  if (artifact.type !== "pull_request") {
    return false;
  }

  try {
    const parsed = new URL(artifact.url);
    return (parsed.hostname === "github.com" || parsed.hostname.endsWith(".github.com")) && /\/pull\/\d+$/.test(parsed.pathname);
  } catch {
    return false;
  }
};

const linearIssueToTask = (config: WorkspaceConfig, node: LinearIssueNode): Task => {
  const metadata = parseLinearMetadata(node.description ?? "", node.branchName ?? node.identifier.toLowerCase());
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
    targets: metadata.targets,
    targetDependencies: metadata.targetDependencies,
    dependencies: metadata.dependencies,
    artifacts: node.attachments.nodes.flatMap((attachment) =>
      isGithubPullRequestArtifact({ type: "pull_request", url: attachment.url })
        ? [
            {
              type: "pull_request" as const,
              url: attachment.url,
              ...(attachment.title ? { title: attachment.title } : {}),
              externalId: attachment.id,
            },
          ]
        : [],
    ),
    updatedAt: node.updatedAt,
    url: node.url,
  };
};

const isUnknownProviderStateError = (error: unknown): error is ForemanError =>
  isForemanError(error) && error.code === "unknown_provider_state";

export class LinearTaskSystem implements TaskSystem {
  private readonly client: LinearClient;
  private readonly logger: LoggerService;
  private viewerPromise: Promise<LinearViewer> | null = null;
  private teamInfoPromise: Promise<{ id: string; name: string; states: Array<{ id: string; name: string }> }> | null = null;

  constructor(
    private readonly config: WorkspaceConfig,
    private readonly env: Record<string, string>,
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

  async validateStartup(): Promise<void> {
    const linear = this.config.taskSystem.linear!;
    this.logger.info("validating Linear startup configuration", { team: linear.team });
    try {
      const team = await this.getConfiguredTeamInfo();
      const response = await this.client.request<{
        issueLabels: { nodes: Array<{ id: string; name: string }> };
      }>(
        `query ValidateForemanStartup {
          issueLabels {
            nodes { id name }
          }
        }`,
        {},
      );

      const configuredStates = [
        ...linear.states.ready,
        ...linear.states.inProgress,
        ...linear.states.inReview,
        ...linear.states.done,
        ...linear.states.canceled,
      ];
      const availableStates = new Set(team.states.map((state) => state.name));
      for (const state of configuredStates) {
        if (!availableStates.has(state)) {
          this.logger.error("Linear startup validation failed because a configured state was not found", { state, team: linear.team });
          throw new ForemanError("linear_state_not_found", `Configured Linear state not found: ${state}`);
        }
      }

      const requiredLabels = [...linear.includeLabels, linear.consolidatedLabel];
      const availableLabels = new Set(response.issueLabels.nodes.map((label) => label.name));
      for (const label of requiredLabels) {
        if (!availableLabels.has(label)) {
          this.logger.error("Linear startup validation failed because a configured label was not found", { label, team: linear.team });
          throw new ForemanError("linear_label_not_found", `Configured Linear label not found: ${label}`);
        }
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

    const tasks = data.issues.nodes.flatMap((node) => {
      try {
        return [linearIssueToTask(this.config, node)];
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
        return [];
      }
    });

    this.logger.debug("listed Linear candidate issues", {
      count: data.issues.nodes.length,
      acceptedCount: tasks.length,
      skippedCount: data.issues.nodes.length - tasks.length,
    });
    return tasks;
  }

  async getTask(taskId: string): Promise<Task> {
    this.logger.debug("fetching Linear issue", { taskId });
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

    this.logger.debug("fetched Linear issue", { taskId, providerId: issue.id, state: issue.state.name });
    return linearIssueToTask(this.config, issue);
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

  async addArtifact(input: { taskId: string; artifact: TaskArtifact }): Promise<void> {
    this.logger.info("skipping Linear attachment mutation for pull request artifact", {
      taskId: input.taskId,
      artifactType: input.artifact.type,
      artifactUrl: input.artifact.url,
    });
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
