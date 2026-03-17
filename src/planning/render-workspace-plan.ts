import { promises as fs } from "node:fs";
import path from "node:path";

import type { LoggerService } from "../logger.js";
import { renderPlanPrompt } from "../prompts.js";
import type { ForemanRepos } from "../repos/index.js";
import { atomicWriteFile } from "../lib/fs.js";
import { discoverGitRepos } from "../workspace/git-repo-discovery.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import { loadWorkspace } from "../workspace/load-workspace.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

export const renderWorkspacePlan = async (
  workspaceName: string,
  foremanRepos?: ForemanRepos,
  logger?: LoggerService,
): Promise<{ config: WorkspaceConfig; paths: WorkspacePaths; markdown: string; contextPath: string }> => {
  const { config, paths } = await loadWorkspace(workspaceName);
  const workspaceLogger = logger?.child({ component: "workspace.plan", workspace: config.workspace.name });
  workspaceLogger?.info("rendering workspace plan");
  const discoveredRepos = await discoverGitRepos(config, paths);
  workspaceLogger?.info("discovered repositories for workspace plan", { repoCount: discoveredRepos.length });
  const { markdown, context } = await renderPlanPrompt(config, paths, discoveredRepos);

  await atomicWriteFile(paths.planPath, markdown);
  workspaceLogger?.info("wrote workspace plan prompt", { planPath: paths.planPath });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relativeJsonPath = path.join("artifacts", `plan-context-${timestamp}.json`);
  const absoluteJsonPath = path.join(paths.workspaceRoot, relativeJsonPath);
  await atomicWriteFile(absoluteJsonPath, `${JSON.stringify(context, null, 2)}\n`);
  workspaceLogger?.info("wrote workspace plan context", { contextPath: absoluteJsonPath });

  if (foremanRepos) {
    const planStat = await fs.stat(paths.planPath);
    const planContextStat = await fs.stat(absoluteJsonPath);
    foremanRepos.artifacts.createArtifact({
      ownerType: "workspace",
      ownerId: config.workspace.name,
      artifactType: "plan_prompt",
      relativePath: path.relative(paths.workspaceRoot, paths.planPath),
      mediaType: "text/markdown",
      sizeBytes: planStat.size,
    });
    foremanRepos.artifacts.createArtifact({
      ownerType: "workspace",
      ownerId: config.workspace.name,
      artifactType: "plan_context",
      relativePath: relativeJsonPath,
      mediaType: "application/json",
      sizeBytes: planContextStat.size,
    });
    workspaceLogger?.info("recorded workspace plan artifacts", { artifactCount: 2 });
  }

  return { config, paths, markdown, contextPath: absoluteJsonPath };
};
