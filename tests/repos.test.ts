import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/workspace/config.js";
import { discoverGitRepos } from "../src/workspace/git-repo-discovery.js";
import { createTempDir, createWorkspacePaths } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const initGitRepo = async (repoPath: string, options: { separateGitDir?: string } = {}): Promise<void> => {
  await fs.mkdir(repoPath, { recursive: true });

  const args = ["init", "-b", "main"];
  if (options.separateGitDir) {
    await fs.mkdir(path.dirname(options.separateGitDir), { recursive: true });
    args.push("--separate-git-dir", options.separateGitDir);
  }

  await execFileAsync("git", args, { cwd: repoPath });
};

const commitToGitRepo = async (repoPath: string): Promise<void> => {
  await fs.writeFile(path.join(repoPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Foreman Test", "-c", "user.email=foreman@example.com", "commit", "-m", "Initial commit"],
    { cwd: repoPath },
  );
};

const addLinkedWorktree = async (repoPath: string, worktreePath: string): Promise<void> => {
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: repoPath });
};

describe("discoverGitRepos", () => {
  test("skips repos matching repos.ignore patterns", async () => {
    const workspaceRoot = await createTempDir("foreman-repos-test-");
    cleanupDirs.push(workspaceRoot);
    const reposRoot = path.join(workspaceRoot, "repos");
    await fs.mkdir(reposRoot, { recursive: true });

    await initGitRepo(path.join(reposRoot, "kept-repo"));
    await initGitRepo(path.join(reposRoot, "ignored-repo"));

    const config = createDefaultWorkspaceConfig("foo", "file");
    config.repos.roots = ["repos"];
    config.repos.ignore = ["**/ignored-repo"];

    const repos = await discoverGitRepos(config, createWorkspacePaths("/project", workspaceRoot));
    expect(repos.map((repo) => repo.key)).toEqual(["kept-repo"]);
  });

  test("skips linked worktrees discovered under repo roots", async () => {
    const workspaceRoot = await createTempDir("foreman-repos-test-");
    cleanupDirs.push(workspaceRoot);
    const reposRoot = path.join(workspaceRoot, "repos");
    const sourceRepo = path.join(reposRoot, "source-repo");
    const linkedWorktree = path.join(reposRoot, "source-repo-worktree");

    await fs.mkdir(reposRoot, { recursive: true });
    await initGitRepo(sourceRepo);
    await commitToGitRepo(sourceRepo);
    await addLinkedWorktree(sourceRepo, linkedWorktree);

    const config = createDefaultWorkspaceConfig("foo", "file");
    config.repos.roots = ["repos"];

    const repos = await discoverGitRepos(config, createWorkspacePaths("/project", workspaceRoot));
    expect(repos.map((repo) => repo.key)).toEqual(["source-repo"]);
  });

  test("skips repo roots that are linked worktrees", async () => {
    const workspaceRoot = await createTempDir("foreman-repos-test-");
    cleanupDirs.push(workspaceRoot);
    const sourceRepo = path.join(workspaceRoot, "source-repo");
    const linkedWorktree = path.join(workspaceRoot, "linked-root");

    await initGitRepo(sourceRepo);
    await commitToGitRepo(sourceRepo);
    await addLinkedWorktree(sourceRepo, linkedWorktree);

    const config = createDefaultWorkspaceConfig("foo", "file");
    config.repos.roots = ["linked-root"];

    const repos = await discoverGitRepos(config, createWorkspacePaths("/project", workspaceRoot));
    expect(repos).toEqual([]);
  });

  test("keeps gitfile-backed repos that are not linked worktrees", async () => {
    const workspaceRoot = await createTempDir("foreman-repos-test-");
    cleanupDirs.push(workspaceRoot);
    const reposRoot = path.join(workspaceRoot, "repos");
    const repoPath = path.join(reposRoot, "gitfile-repo");
    const separateGitDir = path.join(workspaceRoot, "git-dirs", "gitfile-repo");

    await fs.mkdir(reposRoot, { recursive: true });
    await initGitRepo(repoPath, { separateGitDir });

    const config = createDefaultWorkspaceConfig("foo", "file");
    config.repos.roots = ["repos"];

    const repos = await discoverGitRepos(config, createWorkspacePaths("/project", workspaceRoot));
    expect(repos.map((repo) => repo.key)).toEqual(["gitfile-repo"]);
  });
});
