import { promises as fs } from "node:fs";
import path from "node:path";

import type { RepoRef } from "../domain/index.js";
import { jsonSection, renderPromptTemplate, textSection } from "../prompts/template-renderer.js";
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

const taskCreationPolicyFragment = (config: WorkspaceConfig): string => {
  if (!config.agentTaskCreation.enabled) {
    return "cron-task-creation-disabled";
  }

  if (config.taskSystem.type === "linear") {
    return "cron-task-creation-linear";
  }

  return "cron-task-creation-file";
};

export const renderCronPrompt = async (input: {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  repos: RepoRef[];
  job: CronJobDefinition;
}): Promise<string> => {
  const plan = await readPlan(input.paths);
  const tasksDir = path.join(input.paths.workspaceRoot, input.config.taskSystem.file?.tasksDir ?? "tasks");

  return renderPromptTemplate({
    paths: input.paths,
    template: "cron",
    context: {
      workspace: jsonSection("Workspace Context", {
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
      repos: jsonSection("Discovered Repositories", input.repos),
      plan: textSection("Workspace Plan", plan || `No plan.md was found at ${input.paths.planPath}.`),
      body: textSection("Cron Markdown Body", input.job.body),
    },
    fragmentAliases: {
      "cron-task-creation-policy": taskCreationPolicyFragment(input.config),
    },
    properties: {
      cron: {
        planPath: input.paths.planPath,
        tasksDir,
      },
    },
  });
};
