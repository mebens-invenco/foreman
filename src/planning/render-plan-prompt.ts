import type { RepoRef } from "../domain/index.js";
import {
  jsonSection,
  textSection,
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
  const learningsCliGuidance = [
    "Search the workspace learnings database on demand before decomposition or ticket authoring; do not assume learnings are embedded in this prompt.",
    `Use \`foreman learnings search ${config.workspace.name} --repo shared --repo <repo-key> --query \"<topic>\" [--query \"<topic>\" ...]\` to shortlist relevant learnings.`,
    `If \`foreman\` is not on your PATH, use \`yarn foreman learnings search ${config.workspace.name} ...\` after a local build so the bundled CLI still works.`,
    `Use \`foreman learnings get ${config.workspace.name} --id <learning-id> [--id <learning-id> ...]\` to inspect the shortlisted learnings before finalizing tasks.`,
    "When a task clearly belongs to a repo, search both `shared` and that repo's scope. If no strong relevant learnings are found, say so explicitly in the task's `Relevant Learnings` section.",
    "Generated tasks should cite only relevant learning IDs and titles, not the full learning bodies.",
  ].join("\n");

  const planningContext = {
    workspaceConfig: config,
    repos,
    learningsCliGuidance,
    optionalPlanningNotes: "",
  };

  return {
    markdown: await renderPromptTemplate({
      paths,
      template: "plan",
      fragmentAliases: {
        "task-system-planning": taskSystemPlanningFragmentName(config),
      },
      context: {
        workspace: jsonSection("Workspace Context", planningContext.workspaceConfig),
        repos: jsonSection("Discovered Repositories", planningContext.repos),
        learnings: textSection("Learnings CLI", planningContext.learningsCliGuidance),
        "optional-planning-notes": "",
      },
    }),
    context: planningContext,
  };
};
