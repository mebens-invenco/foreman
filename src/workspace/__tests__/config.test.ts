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
    expect(parsed.cron).toEqual({ enabled: false, jobsDir: "cron" });
    expect(parsed.agentTaskCreation).toEqual({ enabled: false });
    expect(parsed.scheduler.workerConcurrency).toBe(4);
    expect(parsed.http.port).toBe(8765);
  });

  test("round-trips default Linear agent-created label", () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.taskSystem.linear!.agentCreatedLabel).toBe("Agent Created");
  });

  test("routes review to execution and reviewer to reviewer runner", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");

    expect(runnerForAction(config, "review")).toEqual(config.runner.execution);
    expect(runnerForAction(config, "reviewer")).toEqual(config.runner.reviewer);
  });

  test("persists cron and agent task creation settings", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.cron.enabled = true;
    config.cron.jobsDir = "automation";
    config.agentTaskCreation.enabled = true;

    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.cron).toEqual({ enabled: true, jobsDir: "automation" });
    expect(parsed.agentTaskCreation).toEqual({ enabled: true });
  });

  test("persists Linear agent-created label", () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.agentCreatedLabel = "AI Generated";

    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.taskSystem.linear!.agentCreatedLabel).toBe("AI Generated");
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

  test("accepts legacy reviewer runner override", () => {
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
  type: opencode
  model: openai/gpt-5.4
  variant: high
  timeoutMs: 3600000
reviewer:
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
      type: "opencode",
      model: "openai/gpt-5.4",
      variant: "high",
      timeoutMs: 3_600_000,
    });
    expect(parsed.runner.reviewer).toEqual({
      type: "claude",
      model: "claude-opus-4-6",
      effort: "max",
      timeoutMs: 120_000,
    });
    expect(parsed.reviewer.agentPrefix).toBe("[review agent] ");
  });

  test("accepts legacy reviewer runner override without explicit reviewer type", () => {
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
  type: opencode
  model: openai/gpt-5.4
  variant: high
  timeoutMs: 3600000
reviewer:
  runner:
    model: openai/gpt-5.4
    variant: medium
    timeoutMs: 240000
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
      type: "opencode",
      model: "openai/gpt-5.4",
      variant: "high",
      timeoutMs: 3_600_000,
    });
    expect(parsed.runner.reviewer).toEqual({
      type: "opencode",
      model: "openai/gpt-5.4",
      variant: "medium",
      timeoutMs: 240_000,
    });
  });

  test("accepts legacy flat opencode runner config without explicit type", () => {
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
  model: openai/gpt-5.4
  variant: low
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
      type: "opencode",
      model: "openai/gpt-5.4",
      variant: "low",
      timeoutMs: 120_000,
    });
    expect(parsed.runner.reviewer).toEqual(parsed.runner.execution);
  });

  test("accepts legacy reviewer runner override when flat runner omits type", () => {
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
  model: openai/gpt-5.4
  variant: low
  timeoutMs: 120000
reviewer:
  runner:
    model: openai/gpt-5.4
    variant: medium
    timeoutMs: 240000
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
      type: "opencode",
      model: "openai/gpt-5.4",
      variant: "low",
      timeoutMs: 120_000,
    });
    expect(parsed.runner.reviewer).toEqual({
      type: "opencode",
      model: "openai/gpt-5.4",
      variant: "medium",
      timeoutMs: 240_000,
    });
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
