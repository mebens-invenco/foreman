import { describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig, parseWorkspaceConfig, runnerForAction, stringifyWorkspaceConfig } from "../config.js";

describe("workspace config", () => {
  test("round-trips default file task config", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.workspace.name).toBe("foo");
    expect(parsed.taskSystem.type).toBe("file");
    expect(parsed.runner.execution).toEqual({
      type: "opencode",
      model: "openai/gpt-5.4",
      variant: "high",
      timeoutMs: 3_600_000,
    });
    expect(parsed.runner.reviewer).toEqual({
      type: "claude",
      model: "claude-opus-4-6",
      effort: "high",
      timeoutMs: 3_600_000,
    });
    expect(parsed.reviewer.agentPrefix).toBe("[review agent] ");
    expect(parsed.scheduler.workerConcurrency).toBe(4);
    expect(parsed.http.port).toBe(8765);
  });

  test("routes review to execution and reviewer to reviewer runner", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");

    expect(runnerForAction(config, "review")).toEqual(config.runner.execution);
    expect(runnerForAction(config, "reviewer")).toEqual(config.runner.reviewer);
  });

  test("accepts legacy flat claude runner config", () => {
    const parsed = parseWorkspaceConfig(`
version: 1
workspace:
  name: foo
repos:
  explicit: []
  roots: []
  ignore: []
taskSystem:
  type: file
  file:
    tasksDir: tasks
    idPrefix: TASK
    states:
      ready: [ready]
      inProgress: [in_progress]
      inReview: [in_review]
      done: [done]
      canceled: [canceled]
reviewSystem:
  type: github
runner:
  type: claude
  model: claude-opus-4-6
  effort: max
  timeoutMs: 120000
scheduler:
  workerConcurrency: 4
  scoutPollIntervalSeconds: 60
  scoutRerunDebounceMs: 1000
  leaseTtlSeconds: 120
  workerHeartbeatSeconds: 15
  staleLeaseReapIntervalSeconds: 15
  schedulerLoopIntervalMs: 1000
  shutdownGracePeriodSeconds: 10
http:
  host: 127.0.0.1
  port: 8765
`);

    expect(parsed.runner.execution).toEqual({
      type: "claude",
      model: "claude-opus-4-6",
      effort: "max",
      timeoutMs: 120_000,
    });
    expect(parsed.runner.reviewer).toEqual(parsed.runner.execution);
  });

  test("rejects mismatched task system blocks", () => {
    expect(() =>
      parseWorkspaceConfig(`
version: 1
workspace:
  name: foo
  agentPrefix: "[agent] "
repos:
  explicit: []
  roots: []
  ignore: []
taskSystem:
  type: linear
reviewSystem:
  type: github
runner:
  type: opencode
  model: openai/gpt-5.4
  variant: high
  timeoutMs: 3600000
scheduler:
  workerConcurrency: 4
  scoutPollIntervalSeconds: 60
  scoutRerunDebounceMs: 1000
  leaseTtlSeconds: 120
  workerHeartbeatSeconds: 15
  staleLeaseReapIntervalSeconds: 15
  schedulerLoopIntervalMs: 1000
  shutdownGracePeriodSeconds: 10
http:
  host: 127.0.0.1
  port: 8765
`),
    ).toThrow(/taskSystem\.linear/);
  });
});
