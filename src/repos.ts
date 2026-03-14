import { promises as fs } from "node:fs";
import path from "node:path";

import { ForemanError } from "./lib/errors.js";
import { exec } from "./lib/process.js";
import type { RepoRef } from "./domain.js";
import type { WorkspaceConfig, WorkspacePaths } from "./config.js";

const isGitRepo = async (repoPath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(path.join(repoPath, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
};

const resolveDefaultBranch = async (repoPath: string): Promise<string> => {
  try {
    const remoteHead = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: repoPath });
    const match = remoteHead.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // ignore and fall through
  }

  const branchList = await exec("git", ["branch", "--format=%(refname:short)"], { cwd: repoPath });
  const branches = branchList.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return branches.includes("main") ? "main" : branches.includes("master") ? "master" : branches[0] ?? "main";
};

export const discoverRepos = async (config: WorkspaceConfig, paths: WorkspacePaths): Promise<RepoRef[]> => {
  const resolved = new Map<string, RepoRef>();

  const addRepo = async (candidate: string): Promise<void> => {
    const absolute = path.resolve(paths.workspaceRoot, candidate);
    const real = await fs.realpath(absolute);

    if (!(await isGitRepo(real))) {
      throw new ForemanError("invalid_repo", `Configured repo path is not a git repo: ${candidate}`);
    }

    const key = path.basename(real);
    const existing = [...resolved.values()].find((repo) => repo.key === key && repo.rootPath !== real);
    if (existing) {
      throw new ForemanError("duplicate_repo_key", `Discovered multiple repos with key ${key}`);
    }

    if (!resolved.has(real)) {
      resolved.set(real, {
        key,
        rootPath: real,
        defaultBranch: await resolveDefaultBranch(real),
      });
    }
  };

  for (const explicit of config.repos.explicit) {
    await addRepo(explicit);
  }

  for (const rootEntry of config.repos.roots) {
    const rootPath = path.resolve(paths.workspaceRoot, rootEntry);

    let stat;
    try {
      stat = await fs.stat(rootPath);
    } catch {
      throw new ForemanError("missing_repo_root", `Configured repo root does not exist: ${rootEntry}`);
    }

    if (!stat.isDirectory()) {
      throw new ForemanError("invalid_repo_root", `Configured repo root is not a directory: ${rootEntry}`);
    }

    if (await isGitRepo(rootPath)) {
      await addRepo(rootPath);
    }

    const children = await fs.readdir(rootPath, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) {
        continue;
      }

      const childPath = path.join(rootPath, child.name);
      if (await isGitRepo(childPath)) {
        await addRepo(childPath);
      }
    }
  }

  return [...resolved.values()].sort((a, b) => a.key.localeCompare(b.key));
};
