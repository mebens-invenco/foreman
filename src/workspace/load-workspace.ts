import { promises as fs } from "node:fs";

import dotenv from "dotenv";

import { ForemanError } from "../lib/errors.js";
import { pathExists } from "../lib/fs.js";
import type { WorkspaceConfig } from "./config.js";
import { parseWorkspaceConfig } from "./config.js";
import type { WorkspacePaths } from "./workspace-paths.js";
import { FOREMAN_CONFIG_FILE, resolveWorkspacePaths } from "./workspace-paths.js";

export const loadWorkspace = async (
  workspaceName: string,
): Promise<{ paths: WorkspacePaths; config: WorkspaceConfig; env: Record<string, string> }> => {
  const paths = await resolveWorkspacePaths(workspaceName);

  if (!(await pathExists(paths.configPath))) {
    throw new ForemanError("workspace_not_initialized", `Workspace ${workspaceName} is missing ${FOREMAN_CONFIG_FILE}`, 404);
  }

  const [configRaw, envRaw] = await Promise.all([
    fs.readFile(paths.configPath, "utf8"),
    pathExists(paths.envPath).then((exists) => (exists ? fs.readFile(paths.envPath, "utf8") : "")),
  ]);

  const config = parseWorkspaceConfig(configRaw);
  const env = dotenv.parse(envRaw);

  return { paths, config, env };
};
