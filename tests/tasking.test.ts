import { describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/config.js";
import { createTaskSystem } from "../src/tasking/index.js";

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
});
