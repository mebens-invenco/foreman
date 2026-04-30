import { promises as fs } from "node:fs";
import path from "node:path";

import type { RepoRef } from "../domain/index.js";
import { jsonSection, markdownSection, textSection } from "../prompts/template-renderer.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";
import type { CronJobDefinition } from "./cron-jobs.js";

const readPlan = async (paths: WorkspacePaths): Promise<string> => {
  try {
    return await fs.readFile(paths.planPath, "utf8");
  } catch {
    return "";
  }
};

const renderTaskCreationPolicy = (config: WorkspaceConfig, paths: WorkspacePaths): string => {
  if (!config.agentTaskCreation.enabled) {
    return [
      "Task creation is disabled for this workspace.",
      "Run in analysis-only mode.",
      "Do not create provider tasks, file tasks, issues, or follow-up work items.",
      "Return natural-language observations and recommendations only.",
    ].join("\n");
  }

  if (config.taskSystem.type === "linear") {
    return [
      "Task creation is enabled for this Linear workspace.",
      "Use LINEAR_API_KEY from the environment for Linear API access; never print, log, or expose its value.",
      "Create follow-up tasks only when they are supported by the workspace plan and the cron job findings.",
    ].join("\n");
  }

  const tasksDir = path.join(paths.workspaceRoot, config.taskSystem.file?.tasksDir ?? "tasks");
  return [
    "Task creation is enabled for this file-backed workspace.",
    `Create task markdown files in ${tasksDir} using the workspace's existing markdown/frontmatter conventions.`,
    "Keep frontmatter valid YAML and include enough body context for a future worker to execute the task.",
  ].join("\n");
};

export const renderCronPrompt = async (input: {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  repos: RepoRef[];
  job: CronJobDefinition;
}): Promise<string> => {
  const plan = await readPlan(input.paths);

  return [
    "# Foreman Cron Job",
    markdownSection(
      "Objective",
      "Execute the selected workspace-defined cron job. Natural-language output is valid; do not emit `<agent-result>` or JSON worker result blocks.",
    ),
    jsonSection("Workspace Context", {
      workspace: input.config.workspace.name,
      workspaceRoot: input.paths.workspaceRoot,
      cronJob: {
        id: input.job.id,
        title: input.job.title,
        interval: input.job.interval,
        relativePath: input.job.relativePath,
      },
      taskSystem: { type: input.config.taskSystem.type },
    }),
    jsonSection("Discovered Repositories", input.repos),
    textSection("Workspace Plan", plan || `No plan.md was found at ${input.paths.planPath}.`),
    markdownSection("Plan Reference", `Read and follow ${input.paths.planPath} when deciding whether follow-up work is needed.`),
    markdownSection("Task Creation Policy", renderTaskCreationPolicy(input.config, input.paths)),
    textSection("Cron Markdown Body", input.job.body),
  ].join("\n\n").trimEnd() + "\n";
};
