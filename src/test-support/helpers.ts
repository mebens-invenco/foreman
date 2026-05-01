import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { createRepos, type ForemanRepos } from "../repos/index.js";
import { openSqliteDatabase, type SqliteForemanDatabase } from "../repos/impl/sqlite-database.js";
import { createDefaultWorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

export const testProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const createTempDir = async (prefix: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), prefix));

export const createWorkspacePaths = (projectRoot: string, workspaceRoot: string): WorkspacePaths => ({
  projectRoot,
  workspaceRoot,
  configPath: path.join(workspaceRoot, "foreman.workspace.yml"),
  envPath: path.join(workspaceRoot, ".env"),
  dbPath: path.join(workspaceRoot, "foreman.db"),
  logsDir: path.join(workspaceRoot, "logs"),
  attemptsLogDir: path.join(workspaceRoot, "logs", "attempts"),
  artifactsDir: path.join(workspaceRoot, "artifacts"),
  worktreesDir: path.join(workspaceRoot, "worktrees"),
  tasksDir: path.join(workspaceRoot, "tasks"),
  planPath: path.join(workspaceRoot, "plan.md"),
});

export const createMigratedDb = async (
  dbPath: string,
  projectRoot: string,
): Promise<ForemanRepos & { database: SqliteForemanDatabase }> => {
  const repos = createRepos(await openSqliteDatabase(dbPath));
  await repos.migrationRunner.runMigrations(projectRoot);
  return repos as ForemanRepos & { database: SqliteForemanDatabase };
};

export const createTestConfig = () => createDefaultWorkspaceConfig("test-workspace", "file");
