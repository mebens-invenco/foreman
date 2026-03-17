import { promises as fs } from "node:fs";
import path from "node:path";

import type { RepoRef, ReviewContext, Task } from "../domain/index.js";
import {
  jsonSection,
  renderPromptTemplate,
  textSection,
  type WorkerPromptTemplateName,
} from "../prompts/template-renderer.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

const readRepoInstructionFile = async (worktreePath: string): Promise<string> => {
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      return await fs.readFile(path.join(worktreePath, fileName), "utf8");
    } catch {
      // continue
    }
  }

  return "";
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
  const repoInstructions = await readRepoInstructionFile(input.worktreePath);
  const repoContext = {
    repo: input.repo,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
  };

  return renderPromptTemplate({
    paths: input.paths,
    template: input.action,
    context: {
      "selected-task": jsonSection("Selected Task", input.task),
      "task-comments": textSection("Task Comments", input.comments),
      repo: jsonSection("Repository Context", repoContext),
      "repo-instructions": textSection("Repo Root Instructions", repoInstructions || "(none provided)"),
      review: jsonSection("Review Context", input.reviewContext ?? null),
    },
  });
};
