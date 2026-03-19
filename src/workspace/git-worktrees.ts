import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveTaskBranchName as resolveTaskTargetBranchName, type ActionType, type RepoRef, type Task, type TaskTarget } from "../domain/index.js";
import { ForemanError } from "../lib/errors.js";
import { ensureDir, pathExists } from "../lib/fs.js";
import { exec } from "../lib/process.js";
import type { WorkspacePaths } from "./workspace-paths.js";

export const resolveTaskBranchName = (task: Task, target?: TaskTarget): string => resolveTaskTargetBranchName(task, target);

const worktreePathForTask = (paths: WorkspacePaths, repo: RepoRef, task: Task): string =>
  path.join(paths.worktreesDir, repo.key, task.id);

const isGitWorktree = async (targetPath: string): Promise<boolean> => {
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: targetPath });
    return true;
  } catch {
    return false;
  }
};

export const ensureTaskWorktree = async (input: {
  paths: WorkspacePaths;
  repo: RepoRef;
  task: Task;
  taskTarget?: TaskTarget;
  baseBranch: string;
  action: ActionType;
}): Promise<string> => {
  const taskBranch = resolveTaskBranchName(input.task, input.taskTarget);
  const targetPath = worktreePathForTask(input.paths, input.repo, input.task);
  await ensureDir(path.dirname(targetPath));

  await exec("git", ["fetch", "origin", input.repo.defaultBranch, input.baseBranch, taskBranch], {
    cwd: input.repo.rootPath,
  }).catch(() => undefined);

  if (!(await pathExists(targetPath))) {
    await exec("git", ["worktree", "add", "-B", taskBranch, targetPath, `origin/${input.baseBranch}`], {
      cwd: input.repo.rootPath,
    });
    return targetPath;
  }

  if (!(await isGitWorktree(targetPath))) {
    throw new ForemanError("invalid_worktree", `Existing worktree path is not a git worktree: ${targetPath}`);
  }

  const currentBranch = await exec("git", ["branch", "--show-current"], { cwd: targetPath });
  if (currentBranch.stdout.trim() !== taskBranch) {
    throw new ForemanError(
      "worktree_branch_mismatch",
      `Existing task worktree is on ${currentBranch.stdout.trim()} instead of ${taskBranch}`,
    );
  }

  if (input.action === "retry") {
    await exec("git", ["fetch", "origin", input.baseBranch], { cwd: targetPath });
    await exec("git", ["reset", "--hard", `origin/${input.baseBranch}`], { cwd: targetPath });
    await exec("git", ["clean", "-fd"], { cwd: targetPath });
  }

  return targetPath;
};

export const removeCleanWorktree = async (repo: RepoRef, worktreePath: string): Promise<boolean> => {
  if (!(await pathExists(worktreePath))) {
    return true;
  }

  const status = await exec("git", ["status", "--porcelain"], { cwd: worktreePath });
  if (status.stdout.trim()) {
    return false;
  }

  await exec("git", ["worktree", "remove", worktreePath], { cwd: repo.rootPath });
  return true;
};

export const branchExistsOnOrigin = async (repo: RepoRef, branchName: string): Promise<boolean> => {
  try {
    const output = await exec("git", ["ls-remote", "--heads", "origin", branchName], { cwd: repo.rootPath });
    return output.stdout.trim().length > 0;
  } catch {
    return false;
  }
};

export const isAncestorOnOrigin = async (repo: RepoRef, ancestorBranch: string, descendantBranch: string): Promise<boolean> => {
  try {
    await exec("git", ["fetch", "origin", ancestorBranch, descendantBranch], { cwd: repo.rootPath });
    await exec("git", ["merge-base", "--is-ancestor", `origin/${ancestorBranch}`, `origin/${descendantBranch}`], {
      cwd: repo.rootPath,
    });
    return true;
  } catch {
    return false;
  }
};

export const readAttemptLog = async (logPath: string): Promise<string> => fs.readFile(logPath, "utf8");
