import { describe, expect, test } from "vitest";

import type { Task } from "../../domain/index.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { resolveRunnerConfigForAction } from "../create-agent-runner.js";

const baseTask = (overrides: Partial<Task> = {}): Task => ({
  id: "TASK-0001",
  provider: "file",
  providerId: "TASK-0001",
  title: "task",
  description: "",
  state: "ready",
  providerState: "ready",
  priority: "normal",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "repo-a", branchName: "task-0001", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
  ...overrides,
});

describe("resolveRunnerConfigForAction", () => {
  test("returns the workspace config unchanged when the task has no override", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    const task = baseTask();
    expect(resolveRunnerConfigForAction(config, "execution", task)).toEqual(config.runner.execution);
    expect(resolveRunnerConfigForAction(config, "reviewer", task)).toEqual(config.runner.reviewer);
  });

  test("returns the workspace config unchanged when no task is supplied", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    expect(resolveRunnerConfigForAction(config, "execution")).toEqual(config.runner.execution);
  });

  test("applies execution override for execution actions while preserving provider type", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.runner.execution = { type: "codex", model: "gpt-5.5", effort: "high", timeoutMs: 3_600_000 };
    const task = baseTask({ runnerOverride: { execution: { model: "gpt-5.5-pro", tuning: "xhigh" } } });

    const resolved = resolveRunnerConfigForAction(config, "execution", task);
    expect(resolved).toEqual({ type: "codex", model: "gpt-5.5-pro", effort: "xhigh", timeoutMs: 3_600_000 });
  });

  test("ignores execution override for reviewer actions", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    const task = baseTask({ runnerOverride: { execution: { model: "gpt-5.5-pro" } } });

    expect(resolveRunnerConfigForAction(config, "reviewer", task)).toEqual(config.runner.reviewer);
  });

  test("applies reviewer override for reviewer actions", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.runner.reviewer = { type: "claude", model: "claude-opus-4-7", effort: "high", timeoutMs: 3_600_000 };
    const task = baseTask({ runnerOverride: { reviewer: { tuning: "max" } } });

    expect(resolveRunnerConfigForAction(config, "reviewer", task)).toEqual({
      type: "claude",
      model: "claude-opus-4-7",
      effort: "max",
      timeoutMs: 3_600_000,
    });
  });

  test("uses variant when the active provider is opencode", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.runner.execution = { type: "opencode", model: "openai/gpt-5.5", variant: "high", timeoutMs: 3_600_000 };
    const task = baseTask({ runnerOverride: { execution: { tuning: "max" } } });

    expect(resolveRunnerConfigForAction(config, "execution", task)).toEqual({
      type: "opencode",
      model: "openai/gpt-5.5",
      variant: "max",
      timeoutMs: 3_600_000,
    });
  });

  test("maps tuning to the active provider field", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.runner.execution = { type: "opencode", model: "openai/gpt-5.5", variant: "high", timeoutMs: 3_600_000 };
    const opencodeTask = baseTask({ runnerOverride: { execution: { tuning: "max" } } });
    expect(resolveRunnerConfigForAction(config, "execution", opencodeTask)).toEqual({
      type: "opencode",
      model: "openai/gpt-5.5",
      variant: "max",
      timeoutMs: 3_600_000,
    });

    config.runner.execution = { type: "codex", model: "gpt-5.5", effort: "high", timeoutMs: 3_600_000 };
    const codexTask = baseTask({ runnerOverride: { execution: { tuning: "xhigh" } } });
    expect(resolveRunnerConfigForAction(config, "execution", codexTask)).toEqual({
      type: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      timeoutMs: 3_600_000,
    });
  });

  test("rejects invalid tuning values for the active provider", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.runner.execution = { type: "codex", model: "gpt-5.5", effort: "high", timeoutMs: 3_600_000 };
    const task = baseTask({ runnerOverride: { execution: { tuning: "ultra" } } });

    expect(() => resolveRunnerConfigForAction(config, "execution", task)).toThrow(/Invalid runner override/);
  });

  test("applies continuationEffort only for continuation dispatches", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.runner.execution = { type: "claude", model: "claude-opus-4-8", effort: "max", continuationEffort: "high", timeoutMs: 3_600_000 };

    expect(resolveRunnerConfigForAction(config, "review", null, true)).toMatchObject({ effort: "high" });
    expect(resolveRunnerConfigForAction(config, "review", null, false)).toMatchObject({ effort: "max" });
    // Continuation defaults to false, preserving the pre-existing call shape.
    expect(resolveRunnerConfigForAction(config, "review", null)).toMatchObject({ effort: "max" });
  });

  test("lets a task tuning override win over continuationEffort", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.runner.execution = { type: "claude", model: "claude-opus-4-8", effort: "max", continuationEffort: "high", timeoutMs: 3_600_000 };
    const task = baseTask({ runnerOverride: { execution: { tuning: "low" } } });

    expect(resolveRunnerConfigForAction(config, "review", task, true)).toMatchObject({ effort: "low" });
  });
});
