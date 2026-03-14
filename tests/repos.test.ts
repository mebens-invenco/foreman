import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/config.js";
import { discoverRepos } from "../src/repos.js";
import { createTempDir, createWorkspacePaths } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const initGitRepo = async (repoPath: string): Promise<void> => {
  await fs.mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
};

describe("discoverRepos", () => {
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

    const repos = await discoverRepos(config, createWorkspacePaths("/project", workspaceRoot));
    expect(repos.map((repo) => repo.key)).toEqual(["kept-repo"]);
  });
});
