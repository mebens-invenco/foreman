import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { pathExists } from "../lib/fs.js";
import type { WorkspacePaths } from "./workspace-paths.js";

export type DeploymentInstructions = {
  absolutePath: string;
  relativePath: string;
  body: string;
  hash: string;
};

export const resolveDeploymentInstructions = async (paths: WorkspacePaths): Promise<DeploymentInstructions | null> => {
  const absolutePath = path.join(paths.workspaceRoot, "deployment.md");
  if (!(await pathExists(absolutePath))) {
    return null;
  }

  const body = await fs.readFile(absolutePath, "utf8");
  return {
    absolutePath,
    relativePath: path.relative(paths.workspaceRoot, absolutePath),
    body,
    hash: crypto.createHash("sha256").update(body).digest("hex"),
  };
};

export const readWorkspacePlan = async (paths: WorkspacePaths): Promise<string> => {
  try {
    return await fs.readFile(paths.planPath, "utf8");
  } catch {
    return "";
  }
};
