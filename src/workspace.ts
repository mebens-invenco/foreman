import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkspaceConfig, WorkspacePaths } from "./config.js";
import { createDefaultWorkspaceConfig, loadWorkspaceConfig, resolveWorkspacePaths, stringifyWorkspaceConfig } from "./config.js";
import { ForemanError } from "./lib/errors.js";
import { atomicWriteFile, ensureDir, isDirectoryEmpty, pathExists } from "./lib/fs.js";
import type { LoggerService } from "./logger.js";
import { applyMigrations, ForemanDb, openDatabase } from "./db.js";
import { renderPlanPrompt } from "./prompts.js";
import { discoverRepos } from "./repos.js";

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

  const db = new ForemanDb(await openDatabase(paths.dbPath));
  try {
    await applyMigrations(db.sqlite, paths.projectRoot);
  } finally {
    db.close();
  }

  return paths;
};

export const renderWorkspacePlan = async (
  workspaceName: string,
  db?: ForemanDb,
  logger?: LoggerService,
): Promise<{ config: WorkspaceConfig; paths: WorkspacePaths; markdown: string; contextPath: string }> => {
  const { config, paths } = await loadWorkspaceConfig(workspaceName);
  const workspaceLogger = logger?.child({ component: "workspace.plan", workspace: config.workspace.name });
  workspaceLogger?.info("rendering workspace plan");
  const repos = await discoverRepos(config, paths);
  workspaceLogger?.info("discovered repositories for workspace plan", { repoCount: repos.length });
  const { markdown, context } = await renderPlanPrompt(config, paths, repos);

  await atomicWriteFile(paths.planPath, markdown);
  workspaceLogger?.info("wrote workspace plan prompt", { planPath: paths.planPath });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relativeJsonPath = path.join("artifacts", `plan-context-${timestamp}.json`);
  const absoluteJsonPath = path.join(paths.workspaceRoot, relativeJsonPath);
  await atomicWriteFile(absoluteJsonPath, `${JSON.stringify(context, null, 2)}\n`);
  workspaceLogger?.info("wrote workspace plan context", { contextPath: absoluteJsonPath });

  if (db) {
    const planStat = await fs.stat(paths.planPath);
    const planContextStat = await fs.stat(absoluteJsonPath);
    db.createArtifact({
      ownerType: "workspace",
      ownerId: config.workspace.name,
      artifactType: "plan_prompt",
      relativePath: path.relative(paths.workspaceRoot, paths.planPath),
      mediaType: "text/markdown",
      sizeBytes: planStat.size,
    });
    db.createArtifact({
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
  const db = new ForemanDb(await openDatabase(paths.dbPath));
  try {
    db.importLegacyDatabase(legacyDbPath);
  } finally {
    db.close();
  }
};
