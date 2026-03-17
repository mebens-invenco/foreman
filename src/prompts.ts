import { promises as fs } from "node:fs";
import path from "node:path";

import type { RepoRef, ReviewContext, Task } from "./domain/index.js";
import type { WorkspaceConfig } from "./workspace/config.js";
import type { WorkspacePaths } from "./workspace/workspace-paths.js";

type PromptTemplateName = "plan" | "execution" | "review" | "retry" | "consolidation";
type WorkerPromptTemplateName = Exclude<PromptTemplateName, "plan">;

const TEMPLATE_PATHS: Record<PromptTemplateName, string> = {
  plan: "prompts/templates/plan.md",
  execution: "prompts/templates/execution.md",
  review: "prompts/templates/review.md",
  retry: "prompts/templates/retry.md",
  consolidation: "prompts/templates/consolidation.md",
};

const fragmentTokenPattern = /\{\{fragment:([a-zA-Z0-9_-]+)\}\}/g;
const contextTokenPattern = /\{\{context:([a-zA-Z0-9_-]+)\}\}/g;

const markdownSection = (title: string, body: string): string => `## ${title}\n\n${body}`;

const jsonSection = (title: string, value: unknown): string =>
  markdownSection(title, ["```json", JSON.stringify(value, null, 2), "```"].join("\n"));

const textSection = (title: string, body: string): string => markdownSection(title, body.trim() || "(none)");

const taskSystemPlanningFragmentName = (config: WorkspaceConfig): string =>
  config.taskSystem.type === "linear" ? "task-system-linear-planning" : "task-system-file-planning";

const loadPromptAssets = async (
  paths: WorkspacePaths,
  template: PromptTemplateName,
): Promise<{ template: string; fragments: Record<string, string> }> => {
  const templatePath = path.join(paths.projectRoot, TEMPLATE_PATHS[template]);
  const fragmentsDir = path.join(paths.projectRoot, "prompts", "fragments");
  const fragmentEntries = (await fs.readdir(fragmentsDir)).filter((entry) => entry.endsWith(".md")).sort();

  const fragments = Object.fromEntries(
    await Promise.all(
      fragmentEntries.map(async (entry) => [entry.replace(/\.md$/, ""), await fs.readFile(path.join(fragmentsDir, entry), "utf8")]),
    ),
  );

  return {
    template: await fs.readFile(templatePath, "utf8"),
    fragments,
  };
};

const renderTemplate = (input: {
  template: string;
  fragments: Record<string, string>;
  context: Record<string, string>;
  fragmentAliases?: Record<string, string>;
}): string => {
  const renderFragments = (value: string): string =>
    value.replace(fragmentTokenPattern, (_match, rawName) => {
      const name = input.fragmentAliases?.[rawName] ?? rawName;
      const fragment = input.fragments[name];
      return fragment ? renderFragments(fragment) : "";
    });

  const withFragments = renderFragments(input.template);
  const withContext = withFragments.replace(contextTokenPattern, (_match, rawName) => input.context[rawName] ?? "");
  return `${withContext.trim()}\n`;
};

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

export const renderPlanPrompt = async (
  config: WorkspaceConfig,
  paths: WorkspacePaths,
  repos: RepoRef[],
): Promise<{ markdown: string; context: Record<string, unknown> }> => {
  const assets = await loadPromptAssets(paths, "plan");
  const planningContext = {
    workspaceConfig: config,
    repos,
    optionalPlanningNotes: "",
  };

  return {
    markdown: renderTemplate({
      template: assets.template,
      fragments: assets.fragments,
      fragmentAliases: {
        "task-system-planning": taskSystemPlanningFragmentName(config),
      },
      context: {
        workspace: jsonSection("Workspace Context", planningContext.workspaceConfig),
        repos: jsonSection("Discovered Repositories", planningContext.repos),
        "optional-planning-notes": "",
      },
    }),
    context: planningContext,
  };
};

export const renderWorkerPrompt = async (input: {
  action: WorkerPromptTemplateName;
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
  const repoContext = {
    repo: input.repo,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
  };

  return renderTemplate({
    template: assets.template,
    fragments: assets.fragments,
    context: {
      "selected-task": jsonSection("Selected Task", input.task),
      "task-comments": textSection("Task Comments", input.comments),
      repo: jsonSection("Repository Context", repoContext),
      "repo-instructions": textSection("Repo Root Instructions", repoInstructions || "(none provided)"),
      review: jsonSection("Review Context", input.reviewContext ?? null),
    },
  });
};
