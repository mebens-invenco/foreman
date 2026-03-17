import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkspaceConfig, WorkspacePaths } from "./config.js";
import { createDefaultWorkspaceConfig, loadWorkspaceConfig, resolveWorkspacePaths, stringifyWorkspaceConfig } from "./config.js";
import { ForemanError } from "./lib/errors.js";
import { atomicWriteFile, ensureDir, isDirectoryEmpty, pathExists } from "./lib/fs.js";
import type { LoggerService } from "./logger.js";
import { renderPlanPrompt } from "./prompts.js";
import { createRepos, type ForemanRepos } from "./repos/index.js";
import { openSqliteDatabase } from "./repos/impl/sqlite-database.js";
import { discoverGitRepos } from "./workspace/git-repo-discovery.js";

export const initializeWorkspace = async (workspaceName: string, taskSystemType: "linear" | "file"): Promise<WorkspacePaths> => {
  const paths = await resolveWorkspacePaths(workspaceName);

  if (await pathExists(paths.workspaceRoot)) {
    if (!(await isDirectoryEmpty(paths.workspaceRoot))) {
      throw new ForemanError("workspace_exists", `Workspace directory already exists and is not empty: ${paths.workspaceRoot}`);
    }
  }

  await ensureDir(paths.workspaceRoot);
  await Promise.all([
    ensureDir(paths.logsDir),
    ensureDir(paths.attemptsLogDir),
    ensureDir(paths.artifactsDir),
    ensureDir(paths.worktreesDir),
    taskSystemType === "file" ? ensureDir(paths.tasksDir) : Promise.resolve(),
  ]);

  const config = createDefaultWorkspaceConfig(workspaceName, taskSystemType);
  await atomicWriteFile(paths.configPath, stringifyWorkspaceConfig(config));

  const envLines = [
    taskSystemType === "linear" ? "LINEAR_API_KEY=" : null,
    "GH_TOKEN=",
    "GH_CONFIG_DIR=",
  ].filter(Boolean);
  await atomicWriteFile(paths.envPath, `${envLines.join("\n")}\n`);

  const repos = createRepos(await openSqliteDatabase(paths.dbPath));
  try {
    await repos.migrationRunner.runMigrations(paths.projectRoot);
  } finally {
    repos.close();
  }

  return paths;
};

export const renderWorkspacePlan = async (
  workspaceName: string,
  repos?: ForemanRepos,
  logger?: LoggerService,
): Promise<{ config: WorkspaceConfig; paths: WorkspacePaths; markdown: string; contextPath: string }> => {
  const { config, paths } = await loadWorkspaceConfig(workspaceName);
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

  if (repos) {
    const planStat = await fs.stat(paths.planPath);
    const planContextStat = await fs.stat(absoluteJsonPath);
    repos.artifacts.createArtifact({
      ownerType: "workspace",
      ownerId: config.workspace.name,
      artifactType: "plan_prompt",
      relativePath: path.relative(paths.workspaceRoot, paths.planPath),
      mediaType: "text/markdown",
      sizeBytes: planStat.size,
    });
    repos.artifacts.createArtifact({
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

export const importLegacyMemory = async (workspaceName: string, legacyDbPath: string): Promise<void> => {
  const { paths } = await loadWorkspaceConfig(workspaceName);
  const repos = createRepos(await openSqliteDatabase(paths.dbPath));
  try {
    repos.migrationRunner.importLegacyDatabase(legacyDbPath);
  } finally {
    repos.close();
  }
};
