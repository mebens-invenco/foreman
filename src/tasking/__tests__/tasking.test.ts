import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import type { Task, TaskArtifact, TaskComment } from "../../domain/index.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { createTaskSystem, SyncedTaskSystem, type TaskSystem } from "../index.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

class FakeTaskSystem implements TaskSystem {
  constructor(private readonly tasks: Task[]) {}

  getProvider(): "file" {
    return "file";
  }

  async listCandidates(): Promise<Task[]> {
    return this.tasks;
  }

  async getTask(taskId: string): Promise<Task> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`missing task ${taskId}`);
    }
    return task;
  }

  async listComments(): Promise<TaskComment[]> {
    return [];
  }

  async addComment(): Promise<void> {}

  async transition(): Promise<void> {}

  async addArtifact(): Promise<void> {}

  async updateLabels(): Promise<void> {}
}

const task = (overrides: Partial<Task> & Pick<Task, "id" | "title" | "state" | "providerState" | "priority" | "updatedAt">): Task => {
  const { id, title, state, providerState, priority, updatedAt, ...rest } = overrides;
  return {
    id,
    provider: "file",
    providerId: id,
    title,
    description: "Task body",
    state,
    providerState,
    priority,
    labels: ["Agent"],
    assignee: null,
    repo: "repo-a",
    branchName: id.toLowerCase(),
    dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
    artifacts: [],
    updatedAt,
    url: null,
    ...rest,
  };
};

describe("createTaskSystem", () => {
  const paths = {
    projectRoot: "/tmp/project",
    workspaceRoot: "/tmp/workspace",
    configPath: "/tmp/workspace/foreman.workspace.yml",
    envPath: "/tmp/workspace/.env",
    dbPath: "/tmp/workspace/foreman.db",
    logsDir: "/tmp/workspace/logs",
    attemptsLogDir: "/tmp/workspace/logs/attempts",
    artifactsDir: "/tmp/workspace/artifacts",
    worktreesDir: "/tmp/workspace/worktrees",
    tasksDir: "/tmp/workspace/tasks",
    planPath: "/tmp/workspace/plan.md",
  };

  test("throws when the file task system config is missing", () => {
    const config = createDefaultWorkspaceConfig("foo", "file") as any;
    delete config.taskSystem.file;

    expect(() =>
      createTaskSystem({
        config,
        paths,
        env: {},
      }),
    ).toThrow("File task system config is required when type=file");
  });

  test("throws when the Linear task system config is missing", () => {
    const config = createDefaultWorkspaceConfig("foo", "linear") as any;
    delete config.taskSystem.linear;

    expect(() =>
      createTaskSystem({
        config,
        paths,
        env: { LINEAR_API_KEY: "test-key" },
      }),
    ).toThrow("Linear task system config is required when type=linear");
  });

  test("throws for unsupported task system types", () => {
    const config = createDefaultWorkspaceConfig("foo", "file") as any;
    config.taskSystem.type = "bogus";

    expect(() =>
      createTaskSystem({
        config,
        paths,
        env: {},
      }),
    ).toThrow("Unsupported task system type: bogus");
  });

  test("syncs mirrored tasks while preserving non-mirrored task fields", async () => {
    const tempDir = await createTempDir("foreman-tasking-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), testProjectRoot);

    try {
      const tasks = [
        task({
          id: "TASK-0001",
          title: "Dependency",
          state: "in_review",
          providerState: "In Review",
          priority: "high",
          updatedAt: "2026-03-18T10:00:00Z",
        }),
        task({
          id: "TASK-0002",
          title: "Candidate",
          state: "ready",
          providerState: "Todo",
          priority: "normal",
          updatedAt: "2026-03-18T10:05:00Z",
          dependencies: { taskIds: ["TASK-0001"], baseTaskId: "TASK-0001", branchNames: ["task-0001"] },
          artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/2" } satisfies TaskArtifact],
        }),
      ];
      const taskSystem = new SyncedTaskSystem(new FakeTaskSystem(tasks), db.taskMirror);

      const candidates = await taskSystem.listCandidates();

      expect(candidates).toHaveLength(2);
      expect(candidates[1]).toMatchObject({
        id: "TASK-0002",
        repo: "repo-a",
        branchName: "task-0002",
        dependencies: {
          taskIds: ["TASK-0001"],
          baseTaskId: "TASK-0001",
          branchNames: ["task-0001"],
        },
        artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/2" }],
      });
      expect(db.taskMirror.listTaskTargets("TASK-0002")).toHaveLength(1);
      expect(db.taskMirror.listTaskDependencies("TASK-0002")).toEqual([
        expect.objectContaining({ dependsOnTaskId: "TASK-0001", isBaseDependency: true }),
      ]);
    } finally {
      db.close();
    }
  });
});
