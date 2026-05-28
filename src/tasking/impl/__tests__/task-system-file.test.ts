import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTempDir, createWorkspacePaths, testProjectRoot } from "../../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../../workspace/config.js";
import { FileTaskSystem } from "../file-task-system.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createFileTaskSystem = async (): Promise<{
  taskSystem: FileTaskSystem;
  workspaceRoot: string;
  taskDir: string;
}> => {
  const workspaceRoot = await createTempDir("foreman-file-task-runner-");
  cleanupDirs.push(workspaceRoot);
  const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
  const config = createDefaultWorkspaceConfig("file-task-runner-override", "file");
  const taskDir = path.join(workspaceRoot, "tasks");
  await fs.mkdir(taskDir, { recursive: true });
  return { taskSystem: new FileTaskSystem(config, paths), workspaceRoot, taskDir };
};

const baseFrontmatter = `id: TASK-0001
title: Test
state: ready
priority: normal
labels:
  - Agent
targets:
  - repoKey: repo-a
    branchName: task-0001
    position: 0
targetDependencies: []
dependsOnTasks: []
baseFromTask: null
baseBranch: null
pullRequests: []
assignee: null
createdAt: 2026-03-14T12:00:00.000Z
updatedAt: 2026-03-14T12:00:00.000Z`;

describe("FileTaskSystem runner override", () => {
  test("parses nested runner.execution and runner.reviewer front matter", async () => {
    const { taskSystem, taskDir } = await createFileTaskSystem();
    const taskPath = path.join(taskDir, "TASK-0001.md");
    await fs.writeFile(
      taskPath,
      `---\n${baseFrontmatter}\nrunner:\n  execution:\n    model: gpt-5.5\n    tuning: xhigh\n  reviewer:\n    model: claude-opus-4-7\n    tuning: max\n---\n\nBody\n`,
    );

    const task = await taskSystem.getTask("TASK-0001");
    expect(task.runnerOverride).toEqual({
      execution: { model: "gpt-5.5", tuning: "xhigh" },
      reviewer: { model: "claude-opus-4-7", tuning: "max" },
    });
  });

  test("parses shorthand runner.model / runner.tuning into execution override", async () => {
    const { taskSystem, taskDir } = await createFileTaskSystem();
    const taskPath = path.join(taskDir, "TASK-0001.md");
    await fs.writeFile(
      taskPath,
      `---\n${baseFrontmatter}\nrunner:\n  model: gpt-5.5\n  tuning: xhigh\n---\n\nBody\n`,
    );

    const task = await taskSystem.getTask("TASK-0001");
    expect(task.runnerOverride).toEqual({
      execution: { model: "gpt-5.5", tuning: "xhigh" },
    });
  });

  test("defaults to null when no runner front matter is present", async () => {
    const { taskSystem, taskDir } = await createFileTaskSystem();
    const taskPath = path.join(taskDir, "TASK-0001.md");
    await fs.writeFile(taskPath, `---\n${baseFrontmatter}\n---\n\nBody\n`);

    const task = await taskSystem.getTask("TASK-0001");
    expect(task.runnerOverride).toBeNull();
  });

  test("preserves runner front matter when transitioning task state", async () => {
    const { taskSystem, taskDir } = await createFileTaskSystem();
    const taskPath = path.join(taskDir, "TASK-0001.md");
    await fs.writeFile(
      taskPath,
      `---\n${baseFrontmatter}\nrunner:\n  execution:\n    model: gpt-5.5\n    tuning: xhigh\n---\n\nBody\n`,
    );

    await taskSystem.transition({ taskId: "TASK-0001", toState: "in_progress" });

    const rewritten = await fs.readFile(taskPath, "utf8");
    expect(rewritten).toContain("runner:");
    expect(rewritten).toContain("model: gpt-5.5");
    expect(rewritten).toContain("tuning: xhigh");
    const reloaded = await taskSystem.getTask("TASK-0001");
    expect(reloaded.runnerOverride).toEqual({ execution: { model: "gpt-5.5", tuning: "xhigh" } });
    expect(reloaded.state).toBe("in_progress");
  });

  test("preserves runner front matter when updating labels", async () => {
    const { taskSystem, taskDir } = await createFileTaskSystem();
    const taskPath = path.join(taskDir, "TASK-0001.md");
    await fs.writeFile(
      taskPath,
      `---\n${baseFrontmatter}\nrunner:\n  reviewer:\n    model: claude-opus-4-7\n    tuning: max\n---\n\nBody\n`,
    );

    await taskSystem.updateLabels({ taskId: "TASK-0001", add: ["Extra"], remove: [] });

    const reloaded = await taskSystem.getTask("TASK-0001");
    expect(reloaded.runnerOverride).toEqual({ reviewer: { model: "claude-opus-4-7", tuning: "max" } });
    expect(reloaded.labels).toContain("Extra");
  });

  test("preserves runner front matter when upserting pull requests", async () => {
    const { taskSystem, taskDir } = await createFileTaskSystem();
    const taskPath = path.join(taskDir, "TASK-0001.md");
    await fs.writeFile(
      taskPath,
      `---\n${baseFrontmatter}\nrunner:\n  execution:\n    model: gpt-5.5\n---\n\nBody\n`,
    );

    await taskSystem.upsertPullRequest({
      taskId: "TASK-0001",
      pullRequest: { repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/1", source: "local" },
    });

    const reloaded = await taskSystem.getTask("TASK-0001");
    expect(reloaded.runnerOverride).toEqual({ execution: { model: "gpt-5.5" } });
    expect(reloaded.pullRequests).toEqual([
      { repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/1", source: "local" },
    ]);
  });
});
