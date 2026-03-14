import { promises as fs } from "node:fs";
import path from "node:path";

import type { ReviewContext, Task } from "./domain.js";
import type { RepoRef } from "./domain.js";
import type { WorkspaceConfig, WorkspacePaths } from "./config.js";

type PromptTemplateName = "plan" | "execution" | "review" | "retry" | "consolidation";

const TEMPLATE_PATHS: Record<PromptTemplateName, string> = {
  plan: "prompts/templates/plan.md",
  execution: "prompts/templates/execution.md",
  review: "prompts/templates/review.md",
  retry: "prompts/templates/retry.md",
  consolidation: "prompts/templates/consolidation.md",
};

const fragmentPath = (name: string): string => `prompts/fragments/${name}.md`;

const renderTextTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{\s*([a-zA-Z0-9_:-]+)\s*\}\}/g, (_match, key) => values[key] ?? "");

export const readRepoInstructionFile = async (worktreePath: string): Promise<string> => {
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      return await fs.readFile(path.join(worktreePath, fileName), "utf8");
    } catch {
      // continue
    }
  }

  return "";
};

const loadPromptAssets = async (paths: WorkspacePaths, template: PromptTemplateName): Promise<{ template: string; fragments: Record<string, string> }> => {
  const templatePath = path.join(paths.projectRoot, TEMPLATE_PATHS[template]);
  const fragmentNames = [
    "worker-common",
    "task-system-linear",
    "task-system-file",
    "task-system-linear-planning",
    "task-system-file-planning",
    "review-github",
    "output-schema",
    "learning-policy",
    "history-policy",
  ];

  const fragments = Object.fromEntries(
    await Promise.all(
      fragmentNames.map(async (name) => [name, await fs.readFile(path.join(paths.projectRoot, fragmentPath(name)), "utf8")]),
    ),
  );

  return {
    template: await fs.readFile(templatePath, "utf8"),
    fragments,
  };
};

const taskSystemFragmentName = (config: WorkspaceConfig, planning: boolean): string => {
  if (config.taskSystem.type === "linear") {
    return planning ? "task-system-linear-planning" : "task-system-linear";
  }

  return planning ? "task-system-file-planning" : "task-system-file";
};

export const renderPlanPrompt = async (
  config: WorkspaceConfig,
  paths: WorkspacePaths,
  repos: RepoRef[],
): Promise<{ markdown: string; context: Record<string, unknown> }> => {
  const assets = await loadPromptAssets(paths, "plan");
  const context = {
    workspace: config.workspace,
    repos,
    taskSystemType: config.taskSystem.type,
    reviewSystemType: config.reviewSystem.type,
    runner: config.runner,
  };

  return {
    markdown: renderTextTemplate(assets.template, {
      workspaceName: config.workspace.name,
      workspaceConfig: JSON.stringify(config, null, 2),
      reposJson: JSON.stringify(repos, null, 2),
      taskSystemPlanningFragment: assets.fragments[taskSystemFragmentName(config, true)] ?? "",
      workerCommon: assets.fragments["worker-common"] ?? "",
      learningPolicy: assets.fragments["learning-policy"] ?? "",
      historyPolicy: assets.fragments["history-policy"] ?? "",
    }),
    context,
  };
};

export const renderWorkerPrompt = async (input: {
  action: PromptTemplateName;
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  task: Task;
  comments: string;
  repo: RepoRef;
  worktreePath: string;
  baseBranch: string;
  reviewContext?: ReviewContext;
}): Promise<string> => {
  const assets = await loadPromptAssets(input.paths, input.action);
  const repoInstructions = await readRepoInstructionFile(input.worktreePath);

  return renderTextTemplate(assets.template, {
    workerCommon: assets.fragments["worker-common"] ?? "",
    taskSystemFragment: assets.fragments[taskSystemFragmentName(input.config, false)] ?? "",
    reviewFragment: assets.fragments["review-github"] ?? "",
    outputSchema: assets.fragments["output-schema"] ?? "",
    learningPolicy: assets.fragments["learning-policy"] ?? "",
    historyPolicy: assets.fragments["history-policy"] ?? "",
    action: input.action,
    taskJson: JSON.stringify(input.task, null, 2),
    comments: input.comments,
    repoJson: JSON.stringify(input.repo, null, 2),
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    repoInstructions,
    reviewContextJson: JSON.stringify(input.reviewContext ?? null, null, 2),
    agentPrefix: input.config.workspace.agentPrefix,
  });
};
