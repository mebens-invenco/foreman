import { promises as fs } from "node:fs";
import path from "node:path";

import { ForemanError } from "./errors.js";

/**
 * Resolve an artifact's DB-recorded `relativePath` to a real filesystem path,
 * enforcing that it stays inside the workspace root — both as a lexical path
 * and after following symlinks. Shared by every reader of artifact files (the
 * HTTP artifact-content endpoint, eval trace harvesting) so the containment
 * rules cannot drift between them.
 *
 * Throws `invalid_artifact_path` on escape and `artifact_file_not_found` when
 * the file is missing on disk.
 */
export const resolveArtifactContentPath = async (workspaceRoot: string, relativePath: string): Promise<string> => {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const isWithinWorkspace = resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
  if (!isWithinWorkspace) {
    throw new ForemanError("invalid_artifact_path", "Artifact path must resolve inside the workspace root.", 400);
  }

  let realWorkspaceRoot = resolvedRoot;
  try {
    realWorkspaceRoot = await fs.realpath(resolvedRoot);
  } catch {
    // Fall back to the resolved workspace root for tests or partially-created workspaces.
  }

  let realResolvedPath: string;
  try {
    realResolvedPath = await fs.realpath(resolvedPath);
  } catch {
    throw new ForemanError("artifact_file_not_found", "Artifact file not found.", 404);
  }

  const isRealPathWithinWorkspace =
    realResolvedPath === realWorkspaceRoot || realResolvedPath.startsWith(`${realWorkspaceRoot}${path.sep}`);
  if (!isRealPathWithinWorkspace) {
    throw new ForemanError("invalid_artifact_path", "Artifact path must resolve inside the workspace root.", 400);
  }

  return realResolvedPath;
};
