import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ForemanVersionMonitor } from "../foreman-version.js";
import { exec } from "../lib/process.js";
import { createTempDir, createWorkspacePaths } from "../test-support/helpers.js";

// Every fixture here drives real `git` subprocess chains, which routinely outrun the 5s global
// default under disk/CPU load. Budgeted here rather than globally: slow git is expected only here.
vi.setConfig({ testTimeout: 30_000 });

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const git = async (cwd: string, args: string[]) => exec("git", args, { cwd });

const commitFile = async (repoRoot: string, fileName: string, content: string, message: string): Promise<void> => {
  await fs.writeFile(path.join(repoRoot, fileName), content);
  await git(repoRoot, ["add", fileName]);
  await git(repoRoot, [
    "-c",
    "user.name=Foreman Test",
    "-c",
    "user.email=foreman@example.test",
    "commit",
    "-m",
    message,
  ]);
};

const createOriginBackedRepo = async () => {
  const root = await createTempDir("foreman-version-test-");
  cleanupDirs.push(root);
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");

  await git(root, ["init", "--bare", origin]);
  await git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await fs.mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await commitFile(repo, "README.md", "initial\n", "initial");
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-u", "origin", "main"]);

  return { root, origin, repo };
};

describe("ForemanVersionMonitor", () => {
  test("reports the current Foreman commit when HEAD matches origin", async () => {
    const { root, repo } = await createOriginBackedRepo();
    const monitor = new ForemanVersionMonitor(createWorkspacePaths(repo, root));

    await monitor.checkNow();

    const status = monitor.getStatus();
    expect(status.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(status.shortCommit).toMatch(/^[0-9a-f]+$/);
    expect(status.upstreamRef).toBe("origin/main");
    expect(status.upstreamCommit).toBe(status.commit);
    expect(status.behindBy).toBe(0);
    expect(status.updateAvailable).toBe(false);
    expect(status.checkedAt).not.toBeNull();
    expect(status.errorMessage).toBeNull();
  });

  test("reports updateAvailable when local HEAD is behind origin", async () => {
    const { root, origin, repo: seedRepo } = await createOriginBackedRepo();
    const localRepo = path.join(root, "local");
    await git(root, ["clone", origin, localRepo]);
    await commitFile(seedRepo, "CHANGELOG.md", "next\n", "next");
    await git(seedRepo, ["push", "origin", "main"]);

    const monitor = new ForemanVersionMonitor(createWorkspacePaths(localRepo, root));

    await monitor.checkNow();

    const status = monitor.getStatus();
    expect(status.upstreamRef).toBe("origin/main");
    expect(status.upstreamCommit).not.toBe(status.commit);
    expect(status.behindBy).toBe(1);
    expect(status.updateAvailable).toBe(true);
    expect(status.errorMessage).toBeNull();
  });

  test("keeps startup-safe status when origin is unavailable", async () => {
    const root = await createTempDir("foreman-version-test-");
    cleanupDirs.push(root);
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, ["init", "-b", "main"]);
    await commitFile(repo, "README.md", "initial\n", "initial");
    await git(repo, ["remote", "add", "origin", path.join(root, "missing.git")]);
    const monitor = new ForemanVersionMonitor(createWorkspacePaths(repo, root));

    await monitor.checkNow();

    const status = monitor.getStatus();
    expect(status.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(status.shortCommit).toMatch(/^[0-9a-f]+$/);
    expect(status.upstreamRef).toBeNull();
    expect(status.upstreamCommit).toBeNull();
    expect(status.behindBy).toBeNull();
    expect(status.updateAvailable).toBe(false);
    expect(status.checkedAt).not.toBeNull();
    expect(status.errorMessage).toEqual(expect.any(String));
  });
});
