import { describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/config.js";
import { createTaskSystem } from "../src/tasking/index.js";

describe("createTaskSystem", () => {
  test("throws for unsupported task system types", () => {
    const config = createDefaultWorkspaceConfig("foo", "file") as any;
    config.taskSystem.type = "bogus";

    expect(() =>
      createTaskSystem({
        config,
        paths: {
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
        },
        env: {},
      }),
    ).toThrow("Unsupported task system type: bogus");
  });
});
