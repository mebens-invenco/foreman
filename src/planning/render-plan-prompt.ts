import type { RepoRef } from "../domain/index.js";
import {
  jsonSection,
  renderPromptTemplate,
} from "../prompts/template-renderer.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

const taskSystemPlanningFragmentName = (config: WorkspaceConfig): string =>
  config.taskSystem.type === "linear" ? "task-system-linear-planning" : "task-system-file-planning";

export const renderPlanPrompt = async (
  config: WorkspaceConfig,
  paths: WorkspacePaths,
  repos: RepoRef[],
): Promise<{ markdown: string; context: Record<string, unknown> }> => {
  const planningContext = {
    workspaceConfig: config,
    repos,
    optionalPlanningNotes: "",
  };

  return {
    markdown: await renderPromptTemplate({
      paths,
      template: "plan",
      fragmentAliases: {
        "task-system-planning": taskSystemPlanningFragmentName(config),
      },
      properties: {
        workspace: config.workspace,
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
