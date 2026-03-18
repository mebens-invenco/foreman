import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { stringifyWorkspaceConfig, createDefaultWorkspaceConfig } from "../src/workspace/config.js";
import { createMigratedDb, createWorkspacePaths } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacesRoot = path.join(projectRoot, "workspaces");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createCliWorkspace = async (): Promise<{ workspaceName: string; workspaceRoot: string }> => {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(workspacesRoot, "foreman-cli-test-"));
  cleanupDirs.push(workspaceRoot);
  const workspaceName = path.basename(workspaceRoot);
  const paths = createWorkspacePaths(projectRoot, workspaceRoot);

  await fs.writeFile(paths.configPath, stringifyWorkspaceConfig(createDefaultWorkspaceConfig(workspaceName, "file")), "utf8");
  await fs.writeFile(paths.envPath, "", "utf8");

  const db = await createMigratedDb(paths.dbPath, projectRoot);
  try {
    db.learnings.addLearning({
      id: "learn-b",
      title: "Planning prompt learnings note",
      repo: "shared",
      confidence: "established",
      content: "planning prompt learnings cli",
      tags: ["planning"],
    });
    db.learnings.addLearning({
      id: "learn-a",
      title: "Planning prompt learnings note",
      repo: "foreman",
      confidence: "proven",
      content: "planning prompt learnings cli",
      tags: ["planning", "cli"],
    });
    db.database.sqlite
      .prepare("UPDATE learning SET updated_at = ? WHERE id IN (?, ?)")
      .run("2026-03-16T00:00:00Z", "learn-a", "learn-b");
  } finally {
    db.close();
  }

  return { workspaceName, workspaceRoot };
};

const getLearningReadCount = async (workspaceRoot: string, id: string): Promise<number> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    const row = db.database.sqlite.prepare("SELECT read_count FROM learning WHERE id = ?").get(id) as { read_count: number } | undefined;
    return Number(row?.read_count ?? 0);
  } finally {
    db.close();
  }
};

const runCli = async (args: string[]): Promise<unknown> => {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: projectRoot });
  return JSON.parse(stdout);
};

describe("learnings cli", () => {
  test("search returns ranked JSON results from the workspace database", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    const output = (await runCli([
      "learnings",
      "search",
      workspaceName,
      "--repo",
      "shared",
      "--repo",
      "foreman",
      "--query",
      "planning prompt",
      "--query",
      "learnings cli",
    ])) as {
      workspace: string;
      repos: string[];
      queries: string[];
      learnings: Array<{ id: string; score: number; content?: string }>;
    };

    expect(output.workspace).toBe(workspaceName);
    expect(output.repos).toEqual(["shared", "foreman"]);
    expect(output.queries).toEqual(["planning prompt", "learnings cli"]);
    expect(output.learnings.map((learning) => learning.id).sort()).toEqual(["learn-a", "learn-b"]);
    expect(output.learnings.every((learning) => Number.isFinite(learning.score))).toBe(true);
    expect(output.learnings[0]!.score).toBeLessThanOrEqual(output.learnings[1]!.score);
    expect(output.learnings.every((learning) => !("content" in learning))).toBe(true);
    expect(await getLearningReadCount(workspaceRoot, "learn-a")).toBe(1);
    expect(await getLearningReadCount(workspaceRoot, "learn-b")).toBe(1);
  });

  test("get returns requested learning details as JSON", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    const output = (await runCli([
      "learnings",
      "get",
      workspaceName,
      "--id",
      "learn-b",
      "--id",
      "learn-a",
      "--id",
      "missing",
    ])) as {
      ids: string[];
      missingIds: string[];
      learnings: Array<{ id: string; content: string }>;
    };

    expect(output.ids).toEqual(["learn-b", "learn-a", "missing"]);
    expect(output.learnings.map((learning) => learning.id)).toEqual(["learn-b", "learn-a"]);
    expect(output.learnings[0]?.content).toBe("planning prompt learnings cli");
    expect(output.missingIds).toEqual(["missing"]);
    expect(await getLearningReadCount(workspaceRoot, "learn-a")).toBe(1);
    expect(await getLearningReadCount(workspaceRoot, "learn-b")).toBe(1);
  });

  test("package.json exposes the built CLI through yarn foreman", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.foreman).toBe("node dist/cli.js");
  });
});
