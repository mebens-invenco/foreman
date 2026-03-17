import path from "node:path";
import { fileURLToPath } from "node:url";

import { ForemanError } from "../lib/errors.js";
import { walkParentsForFile } from "../lib/fs.js";

export type WorkspacePaths = {
  projectRoot: string;
  workspaceRoot: string;
  configPath: string;
  envPath: string;
  dbPath: string;
  logsDir: string;
  attemptsLogDir: string;
  artifactsDir: string;
  worktreesDir: string;
  tasksDir: string;
  planPath: string;
};

export const FOREMAN_CONFIG_FILE = "foreman.workspace.yml";

export const findProjectRoot = async (): Promise<string> => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packagePath = await walkParentsForFile(currentDir, "package.json");

  if (!packagePath) {
    throw new ForemanError("project_root_not_found", "Could not locate Foreman project root", 500);
  }

  return path.dirname(packagePath);
};

export const resolveWorkspacePaths = async (workspaceName: string): Promise<WorkspacePaths> => {
  const projectRoot = await findProjectRoot();
  const workspaceRoot = path.join(projectRoot, "workspaces", workspaceName);

  return {
    projectRoot,
    workspaceRoot,
    configPath: path.join(workspaceRoot, FOREMAN_CONFIG_FILE),
    envPath: path.join(workspaceRoot, ".env"),
    dbPath: path.join(workspaceRoot, "foreman.db"),
    logsDir: path.join(workspaceRoot, "logs"),
    attemptsLogDir: path.join(workspaceRoot, "logs", "attempts"),
    artifactsDir: path.join(workspaceRoot, "artifacts"),
    worktreesDir: path.join(workspaceRoot, "worktrees"),
    tasksDir: path.join(workspaceRoot, "tasks"),
    planPath: path.join(workspaceRoot, "plan.md"),
  };
};
