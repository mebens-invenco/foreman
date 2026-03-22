import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import type { RepoRef, Task } from "../../domain/index.js";
import { createWorkspacePaths, createTempDir } from "../../test-support/helpers.js";
import { ensureTaskWorktree } from "../git-worktrees.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
};

const commitAll = async (cwd: string, message: string): Promise<void> => {
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync(
    "git",
    ["-c", "user.name=Foreman Test", "-c", "user.email=foreman@example.com", "commit", "-m", message],
    { cwd },
  );
};

const writeAndCommit = async (cwd: string, relativePath: string, content: string, message: string): Promise<string> => {
  await fs.writeFile(path.join(cwd, relativePath), content);
  await commitAll(cwd, message);
  return git(cwd, ["rev-parse", "HEAD"]);
};

const pushMain = async (cwd: string): Promise<void> => {
  await execFileAsync("git", ["push", "origin", "main"], { cwd });
};

const createTask = (): Task => ({
  id: "TASK-123",
  provider: "file",
  providerId: "TASK-123",
  title: "Test task",
  description: "",
  state: "ready",
  providerState: "ready",
  priority: "normal",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "repo-a", branchName: "task-123", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  pullRequests: [],
  updatedAt: "2026-03-20T00:00:00Z",
  url: null,
});

const createFixture = async (): Promise<{
  seedPath: string;
  localPath: string;
  repo: RepoRef;
  task: Task;
  workspaceRoot: string;
}> => {
  const root = await createTempDir("foreman-git-worktrees-");
  cleanupDirs.push(root);

  const seedPath = path.join(root, "seed");
  const originPath = path.join(root, "origin.git");
  const localPath = path.join(root, "local");
  const workspaceRoot = path.join(root, "workspace");

  await fs.mkdir(seedPath, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: seedPath });
  await writeAndCommit(seedPath, "README.md", "initial\n", "Initial commit");

  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", originPath]);
  await execFileAsync("git", ["remote", "add", "origin", originPath], { cwd: seedPath });
  await pushMain(seedPath);
  await execFileAsync("git", ["clone", originPath, localPath], { cwd: root });
  await fs.mkdir(workspaceRoot, { recursive: true });

  return {
    seedPath,
    localPath,
    repo: { key: "repo-a", rootPath: localPath, defaultBranch: "main" },
    task: createTask(),
    workspaceRoot,
  };
};

describe("ensureTaskWorktree", () => {
  test("creates a new worktree from the latest origin base even when the task branch is missing on origin", async () => {
    const fixture = await createFixture();
    const latestBaseSha = await writeAndCommit(fixture.seedPath, "README.md", "updated\n", "Update main");
    await pushMain(fixture.seedPath);

    const worktreePath = await ensureTaskWorktree({
      paths: createWorkspacePaths("/project", fixture.workspaceRoot),
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    await expect(git(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(latestBaseSha);
    await expect(git(worktreePath, ["branch", "--show-current"])).resolves.toBe("task-123");
  });

  test("fails when the base branch cannot be fetched from origin", async () => {
    const fixture = await createFixture();

    await expect(
      ensureTaskWorktree({
        paths: createWorkspacePaths("/project", fixture.workspaceRoot),
        repo: fixture.repo,
        task: fixture.task,
        baseBranch: "missing-base",
        action: "execution",
      }),
    ).rejects.toThrow("git fetch origin missing-base failed");
  });

  test("resets a clean existing scaffold branch to the latest origin base", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);

    const firstPath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });
    const originalSha = await git(firstPath, ["rev-parse", "HEAD"]);

    const latestBaseSha = await writeAndCommit(fixture.seedPath, "README.md", "refreshed\n", "Refresh main");
    await pushMain(fixture.seedPath);

    const secondPath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    expect(secondPath).toBe(firstPath);
    expect(await git(secondPath, ["rev-parse", "HEAD"])).toBe(latestBaseSha);
    expect(await git(secondPath, ["rev-parse", "HEAD^"])).toBe(originalSha);
  });

  test("preserves local task commits during normal execution reuse", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);
    const worktreePath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    await writeAndCommit(worktreePath, "task.txt", "task work\n", "Task commit");
    const localTaskSha = await git(worktreePath, ["rev-parse", "HEAD"]);

    await writeAndCommit(fixture.seedPath, "README.md", "upstream\n", "Upstream update");
    await pushMain(fixture.seedPath);

    const reusedPath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    expect(reusedPath).toBe(worktreePath);
    expect(await git(reusedPath, ["rev-parse", "HEAD"])).toBe(localTaskSha);
  });

  test("hard resets retry worktrees to the latest origin base and removes untracked files", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);
    const worktreePath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    await writeAndCommit(worktreePath, "task.txt", "task work\n", "Task commit");
    await fs.writeFile(path.join(worktreePath, "scratch.txt"), "temp\n");

    const latestBaseSha = await writeAndCommit(fixture.seedPath, "README.md", "retry base\n", "Retry base update");
    await pushMain(fixture.seedPath);

    const retriedPath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "retry",
    });

    expect(retriedPath).toBe(worktreePath);
    expect(await git(retriedPath, ["rev-parse", "HEAD"])).toBe(latestBaseSha);
    expect(await git(retriedPath, ["status", "--short"])).toBe("");
  });
});
