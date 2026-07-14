import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { RepoRef, Task } from "../../domain/index.js";
import { createWorkspacePaths, createTempDir } from "../../test-support/helpers.js";
import { ensureTaskWorktree } from "../git-worktrees.js";

// Every test here drives real `git` subprocess chains, which routinely outrun the 5s global
// default under disk/CPU load. Budgeted here rather than globally: slow git is expected only here.
vi.setConfig({ testTimeout: 30_000 });

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
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
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

  test("reattaches detached HEAD when the commit is reachable from the task branch", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);
    const worktreePath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    const taskCommitSha = await writeAndCommit(worktreePath, "task.txt", "task work\n", "Task commit");

    // Simulate the agent doing `git checkout <sha>` (detaches HEAD).
    await git(worktreePath, ["checkout", taskCommitSha]);
    expect(await git(worktreePath, ["branch", "--show-current"])).toBe("");

    const reusedPath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "review",
    });

    expect(reusedPath).toBe(worktreePath);
    expect(await git(reusedPath, ["branch", "--show-current"])).toBe("task-123");
    expect(await git(reusedPath, ["rev-parse", "HEAD"])).toBe(taskCommitSha);
    expect(await git(reusedPath, ["status", "--short"])).toBe("");
  });

  test("preserves uncommitted work when reattaching a dirty detached HEAD", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);
    const worktreePath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    const taskCommitSha = await writeAndCommit(worktreePath, "task.txt", "task work\n", "Task commit");

    await git(worktreePath, ["checkout", taskCommitSha]);
    await fs.writeFile(path.join(worktreePath, "uncommitted.txt"), "agent left this behind\n");

    const reusedPath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "review",
    });

    expect(reusedPath).toBe(worktreePath);
    expect(await git(reusedPath, ["branch", "--show-current"])).toBe("task-123");
    // Uncommitted file is carried forward (parity with the on-branch reuse path —
    // we never silently delete agent work outside the retry action).
    expect(await fs.readFile(path.join(reusedPath, "uncommitted.txt"), "utf8")).toBe(
      "agent left this behind\n",
    );
  });

  test("retry recovers a detached HEAD that is unreachable from the task branch", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);
    const worktreePath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    await git(worktreePath, ["checkout", "-b", "throwaway"]);
    const orphanSha = await writeAndCommit(worktreePath, "orphan.txt", "orphan\n", "Orphan commit");
    await git(worktreePath, ["checkout", orphanSha]);
    await git(worktreePath, ["branch", "-D", "throwaway"]);

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
    expect(await git(retriedPath, ["branch", "--show-current"])).toBe("task-123");
    expect(await git(retriedPath, ["rev-parse", "HEAD"])).toBe(latestBaseSha);
    expect(await git(retriedPath, ["status", "--short"])).toBe("");
  });

  test("throws when detached HEAD's task branch ref is missing locally", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);
    const worktreePath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    const taskCommitSha = await writeAndCommit(worktreePath, "task.txt", "task work\n", "Task commit");

    // Detach onto the commit, then delete the local task branch ref so the
    // ancestry check (`merge-base --is-ancestor HEAD refs/heads/task-123`) fails.
    await git(worktreePath, ["checkout", taskCommitSha]);
    await git(worktreePath, ["branch", "-D", "task-123"]);

    await expect(
      ensureTaskWorktree({
        paths,
        repo: fixture.repo,
        task: fixture.task,
        baseBranch: "main",
        action: "review",
      }),
    ).rejects.toThrow(/detached HEAD/);
  });

  test("throws when HEAD is detached at a commit not reachable from the task branch", async () => {
    const fixture = await createFixture();
    const paths = createWorkspacePaths("/project", fixture.workspaceRoot);
    const worktreePath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: fixture.task,
      baseBranch: "main",
      action: "execution",
    });

    const baseSha = await git(worktreePath, ["rev-parse", "HEAD"]);

    // Create a commit on a throwaway branch the task branch does NOT contain.
    await git(worktreePath, ["checkout", "-b", "throwaway"]);
    const orphanSha = await writeAndCommit(worktreePath, "orphan.txt", "orphan\n", "Orphan commit");

    // Detach onto the orphan commit, then delete the branch so HEAD is purely detached.
    await git(worktreePath, ["checkout", orphanSha]);
    await git(worktreePath, ["branch", "-D", "throwaway"]);
    expect(await git(worktreePath, ["branch", "--show-current"])).toBe("");
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(orphanSha);
    expect(orphanSha).not.toBe(baseSha);

    await expect(
      ensureTaskWorktree({
        paths,
        repo: fixture.repo,
        task: fixture.task,
        baseBranch: "main",
        action: "review",
      }),
    ).rejects.toThrow(/detached HEAD/);
  });

  test("retargets retry worktrees when task branch metadata changes", async () => {
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

    const latestBaseSha = await writeAndCommit(fixture.seedPath, "README.md", "retargeted retry base\n", "Retarget retry base update");
    await pushMain(fixture.seedPath);

    const retargetedTask: Task = {
      ...fixture.task,
      targets: [{ repoKey: "repo-a", branchName: "task-456", position: 0 }],
    };
    const retriedPath = await ensureTaskWorktree({
      paths,
      repo: fixture.repo,
      task: retargetedTask,
      baseBranch: "main",
      action: "retry",
    });

    expect(retriedPath).toBe(worktreePath);
    expect(await git(retriedPath, ["branch", "--show-current"])).toBe("task-456");
    expect(await git(retriedPath, ["rev-parse", "HEAD"])).toBe(latestBaseSha);
    expect(await git(retriedPath, ["status", "--short"])).toBe("");
  });
});
