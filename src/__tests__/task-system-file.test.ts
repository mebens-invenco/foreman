import path from "node:path";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { LoggerService } from "../logger.js";
import { FileTaskSystem } from "../tasking/index.js";
import { createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createTempDir, createWorkspacePaths } from "../test-support/helpers.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const writeTask = async (workspaceRoot: string, input: { id: string; title: string; state: string; repo?: string }): Promise<string> => {
  const taskPath = path.join(workspaceRoot, "tasks", `${input.id}.md`);
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.writeFile(
    taskPath,
    `---
id: ${input.id}
title: ${input.title}
state: ${input.state}
priority: normal
labels:
  - Agent
repo: ${input.repo ?? "repo-a"}
createdAt: 2026-03-14T12:00:00Z
updatedAt: 2026-03-14T12:00:00Z
---

Task body
`,
    "utf8",
  );
  return taskPath;
};

describe("FileTaskSystem", () => {
  test("parses multi-target frontmatter and preserves target dependencies on rewrite", async () => {
    const workspaceRoot = await createTempDir("foreman-file-task-system-");
    cleanupDirs.push(workspaceRoot);

    const taskPath = path.join(workspaceRoot, "tasks", "TASK-0003.md");
    await fs.mkdir(path.dirname(taskPath), { recursive: true });
    await fs.writeFile(
      taskPath,
      `---
id: TASK-0003
title: Multi-target task
state: ready
priority: normal
labels:
  - Agent
targets:
  - repoKey: repo-a
    branchName: task-0003
    position: 0
  - repoKey: repo-b
    branchName: task-0003
    position: 1
targetDependencies:
  - taskTargetRepoKey: repo-b
    dependsOnRepoKey: repo-a
    position: 0
createdAt: 2026-03-14T12:00:00Z
updatedAt: 2026-03-14T12:00:00Z
---

Task body
`,
      "utf8",
    );

    const paths = createWorkspacePaths(workspaceRoot, workspaceRoot);
    const taskSystem = new FileTaskSystem(createDefaultWorkspaceConfig("foo", "file"), paths);

    const task = await taskSystem.getTask("TASK-0003");
    expect(task.repo).toBeNull();
    expect(task.branchName).toBeNull();
    expect(task.targets).toEqual([
      { repoKey: "repo-a", branchName: "task-0003", position: 0 },
      { repoKey: "repo-b", branchName: "task-0003", position: 1 },
    ]);
    expect(task.targetDependencies).toEqual([{ taskTargetRepoKey: "repo-b", dependsOnRepoKey: "repo-a", position: 0 }]);

    await taskSystem.transition({ taskId: "TASK-0003", toState: "in_progress" });

    const rewritten = await fs.readFile(taskPath, "utf8");
    expect(rewritten).toContain("targets:");
    expect(rewritten).toContain("targetDependencies:");
    expect(rewritten).toContain("taskTargetRepoKey: repo-b");
  });

  test("listCandidates skips unmapped states and logs the skipped task", async () => {
    const workspaceRoot = await createTempDir("foreman-file-task-system-");
    cleanupDirs.push(workspaceRoot);

    const invalidTaskPath = await writeTask(workspaceRoot, {
      id: "TASK-0002",
      title: "Bad task",
      state: "blocked",
    });
    await writeTask(workspaceRoot, {
      id: "TASK-0001",
      title: "Valid task",
      state: "ready",
    });

    const paths = createWorkspacePaths(workspaceRoot, workspaceRoot);
    const stdout = new PassThrough();
    stdout.resume();
    const logger = LoggerService.create({
      paths,
      stdout,
      colorMode: "never",
    });
    const taskSystem = new FileTaskSystem(createDefaultWorkspaceConfig("foo", "file"), paths, logger);

    const tasks = await taskSystem.listCandidates();
    await logger.flush();

    expect(tasks.map((task) => task.id)).toEqual(["TASK-0001"]);

    const workspaceLog = await fs.readFile(path.join(workspaceRoot, "logs", "foreman.log"), "utf8");
    expect(workspaceLog).toContain('message="skipping file candidate with unmapped provider state"');
    expect(workspaceLog).toContain('provider="file"');
    expect(workspaceLog).toContain('taskId="TASK-0002"');
    expect(workspaceLog).toContain(`filePath=${JSON.stringify(invalidTaskPath)}`);
    expect(workspaceLog).toContain('providerState="blocked"');
  });

  test("getTask still fails for unmapped provider states", async () => {
    const workspaceRoot = await createTempDir("foreman-file-task-system-");
    cleanupDirs.push(workspaceRoot);

    const paths = createWorkspacePaths(workspaceRoot, workspaceRoot);
    await writeTask(workspaceRoot, {
      id: "TASK-0002",
      title: "Bad task",
      state: "blocked",
    });

    const taskSystem = new FileTaskSystem(createDefaultWorkspaceConfig("foo", "file"), paths);

    await expect(taskSystem.getTask("TASK-0002")).rejects.toMatchObject({ code: "unknown_provider_state" });
  });
});
