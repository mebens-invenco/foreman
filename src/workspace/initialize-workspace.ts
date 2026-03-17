import { createRepos } from "../repos/index.js";
import { openSqliteDatabase } from "../repos/impl/sqlite-database.js";
import { ForemanError } from "../lib/errors.js";
import { atomicWriteFile, ensureDir, isDirectoryEmpty, pathExists } from "../lib/fs.js";
import { createDefaultWorkspaceConfig, stringifyWorkspaceConfig } from "./config.js";
import type { WorkspacePaths } from "./workspace-paths.js";
import { resolveWorkspacePaths } from "./workspace-paths.js";

export const initializeWorkspace = async (
  workspaceName: string,
  taskSystemType: "linear" | "file",
): Promise<WorkspacePaths> => {
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
