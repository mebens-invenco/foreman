import path from "node:path";

import { z } from "zod";

import { resolveTaskPullRequest, resolveTaskTargetRef, type RepoRef, type ReviewContext, type Task, type TaskTargetRef } from "../domain/index.js";
import { jsonSection, renderPromptTemplate, type WorkerPromptTemplateName } from "../prompts/template-renderer.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

const parsePullRequestNumber = (url: string | null): number | null => {
  if (!url) {
    return null;
  }

  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
};

const resolveSelectedTarget = (task: Task, repo: RepoRef, target?: TaskTargetRef): TaskTargetRef | null =>
  target ?? resolveTaskTargetRef(task, repo.key);

const workerPromptPullRequestReferenceSchema = z.object({
  provider: z.literal("github"),
  url: z.string(),
  number: z.number(),
  state: z.enum(["open", "closed", "merged"]).optional(),
  isDraft: z.boolean().optional(),
  headSha: z.string().optional(),
  headBranch: z.string().optional(),
  baseBranch: z.string().optional(),
  headIntroducedAt: z.string().optional(),
  mergeState: z.enum(["clean", "conflicting", "dirty", "unknown"]).optional(),
});

export type WorkerPromptPullRequestReference = z.infer<typeof workerPromptPullRequestReferenceSchema>;

export const parseWorkerPromptPullRequestReference = (value: unknown): WorkerPromptPullRequestReference | undefined => {
  const parsed = workerPromptPullRequestReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const resolveSelectedTaskContext = (task: Task, selectedTarget: TaskTargetRef | null): Record<string, unknown> => ({
  id: task.id,
  provider: task.provider,
  providerId: task.providerId,
  title: task.title,
  url: task.url,
  state: task.state,
  providerState: task.providerState,
  priority: task.priority,
  labels: task.labels,
  assignee: task.assignee,
  selectedTarget,
  dependencies: task.dependencies,
  targetDependencies: task.targetDependencies,
});

const renderSelectedTask = (task: Task, selectedTarget: TaskTargetRef | null): string =>
  jsonSection("Selected Task", resolveSelectedTaskContext(task, selectedTarget));

const resolveRepositoryContext = (input: {
  repo: RepoRef;
  worktreePath: string;
  baseBranch: string;
  selectedTarget: TaskTargetRef | null;
}): Record<string, unknown> => ({
  repo: input.repo,
  worktreePath: input.worktreePath,
  baseBranch: input.baseBranch,
  selectedTarget: input.selectedTarget,
});

const renderRepositoryContext = (input: {
  repo: RepoRef;
  worktreePath: string;
  baseBranch: string;
  selectedTarget: TaskTargetRef | null;
}): string => jsonSection("Repository Context", resolveRepositoryContext(input));

const resolveTaskProviderContext = (input: { config: WorkspaceConfig; paths: WorkspacePaths; task: Task }): Record<string, unknown> => {
  if (input.task.provider === "file") {
    const tasksDir = path.join(input.paths.workspaceRoot, input.config.taskSystem.file?.tasksDir ?? "tasks");
    const taskFilePath = path.join(tasksDir, `${input.task.id}.md`);

    return {
      provider: "file",
      taskFilePath,
      commentsFilePath: taskFilePath.replace(/\.md$/, ".comments.ndjson"),
    };
  }

  return {
    provider: "linear",
    issueIdentifier: input.task.id,
    issueId: input.task.providerId,
    issueUrl: input.task.url,
    credentialNames: ["LINEAR_API_KEY"],
  };
};

const renderTaskProviderContext = (input: { config: WorkspaceConfig; paths: WorkspacePaths; task: Task }): string =>
  jsonSection("Task Provider Context", resolveTaskProviderContext(input));

const resolveGitStateContext = (input: {
  gitState?: {
    worktreeHeadSha: string | null;
    reviewHeadSha: string | null;
    baseBranch: string;
    previousSessionHeadSha: string | null;
  };
  baseBranch: string;
}): Record<string, unknown> => ({
  currentWorktreeHeadSha: input.gitState?.worktreeHeadSha ?? null,
  currentPrHeadSha: input.gitState?.reviewHeadSha ?? null,
  baseBranch: input.gitState?.baseBranch ?? input.baseBranch,
  previousSessionHeadSha: input.gitState?.previousSessionHeadSha ?? null,
});

const renderGitStateContext = (input: {
  gitState?: {
    worktreeHeadSha: string | null;
    reviewHeadSha: string | null;
    baseBranch: string;
    previousSessionHeadSha: string | null;
  };
  baseBranch: string;
}): string => jsonSection("Current Git State", resolveGitStateContext(input));

const reviewContextToPullRequestReference = (context: ReviewContext): WorkerPromptPullRequestReference => ({
  provider: context.provider,
  url: context.pullRequestUrl,
  number: context.pullRequestNumber,
  state: context.state,
  isDraft: context.isDraft,
  headSha: context.headSha,
  headBranch: context.headBranch,
  baseBranch: context.baseBranch,
  headIntroducedAt: context.headIntroducedAt,
  mergeState: context.mergeState,
});

const resolvePullRequestReferenceContext = (input: {
  task: Task;
  repo: RepoRef;
  reviewContext?: ReviewContext;
  pullRequestReference?: WorkerPromptPullRequestReference;
}): Record<string, unknown> => {
  const reference = input.pullRequestReference ?? (input.reviewContext ? reviewContextToPullRequestReference(input.reviewContext) : null);
  if (reference) {
    return {
      ...reference,
      credentialNames: ["GH_TOKEN"],
    };
  }

  const pullRequest = resolveTaskPullRequest(input.task, input.repo.key);
  const url = pullRequest?.url ?? null;

  return {
    provider: url ? "github" : null,
    url,
    number: parsePullRequestNumber(url),
    source: pullRequest?.source ?? null,
    title: pullRequest?.title ?? null,
    credentialNames: ["GH_TOKEN"],
  };
};

const renderPullRequestReference = (input: {
  task: Task;
  repo: RepoRef;
  reviewContext?: ReviewContext;
  pullRequestReference?: WorkerPromptPullRequestReference;
}): string => jsonSection("Pull Request Reference", resolvePullRequestReferenceContext(input));

const renderContinuationContext = (input: {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  task: Task;
  repo: RepoRef;
  selectedTarget: TaskTargetRef | null;
  worktreePath: string;
  baseBranch: string;
  reviewContext?: ReviewContext;
  pullRequestReference?: WorkerPromptPullRequestReference;
  gitState?: {
    worktreeHeadSha: string | null;
    reviewHeadSha: string | null;
    baseBranch: string;
    previousSessionHeadSha: string | null;
  };
}): string =>
  jsonSection("Continuation Context", {
    selectedTask: resolveSelectedTaskContext(input.task, input.selectedTarget),
    taskProvider: resolveTaskProviderContext(input),
    repository: resolveRepositoryContext(input),
    gitState: resolveGitStateContext(input),
    pullRequestReference: resolvePullRequestReferenceContext(input),
  });

const selectWorkerPromptTemplate = (input: {
  action: WorkerPromptTemplateName;
  continuation?: boolean;
}): WorkerPromptTemplateName | "review-continuation" | "reviewer-continuation" => {
  if (!input.continuation) {
    return input.action;
  }
  if (input.action === "review") {
    return "review-continuation";
  }
  if (input.action === "reviewer") {
    return "reviewer-continuation";
  }
  return input.action;
};

export const renderWorkerPrompt = async (input: {
  action: WorkerPromptTemplateName;
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  task: Task;
  repo: RepoRef;
  taskTarget?: TaskTargetRef;
  worktreePath: string;
  baseBranch: string;
  reviewContext?: ReviewContext;
  pullRequestReference?: WorkerPromptPullRequestReference;
  gitState?: {
    worktreeHeadSha: string | null;
    reviewHeadSha: string | null;
    baseBranch: string;
    previousSessionHeadSha: string | null;
  };
  continuation?: boolean;
}): Promise<string> => {
  const selectedTarget = resolveSelectedTarget(input.task, input.repo, input.taskTarget);
  const template = selectWorkerPromptTemplate(input);

  return renderPromptTemplate({
    paths: input.paths,
    template,
    context: {
      "selected-task": renderSelectedTask(input.task, selectedTarget),
      "task-provider": renderTaskProviderContext(input),
      repo: renderRepositoryContext({
        repo: input.repo,
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch,
        selectedTarget,
      }),
      "git-state": renderGitStateContext(input),
      "pull-request": renderPullRequestReference(input),
      "continuation-context": renderContinuationContext({
        config: input.config,
        paths: input.paths,
        task: input.task,
        repo: input.repo,
        selectedTarget,
        worktreePath: input.worktreePath,
        baseBranch: input.baseBranch,
        ...(input.reviewContext ? { reviewContext: input.reviewContext } : {}),
        ...(input.pullRequestReference ? { pullRequestReference: input.pullRequestReference } : {}),
        ...(input.gitState ? { gitState: input.gitState } : {}),
      }),
    },
    fragmentAliases: {
      "task-system-worker": input.config.taskSystem.type === "linear" ? "task-system-linear-worker" : "task-system-file-worker",
    },
    properties: { foreman: { cliPath: path.join(input.paths.projectRoot, "dist/cli.js") }, session: { action: input.action } },
  });
};
