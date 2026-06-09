import { describe, expect, test } from "vitest";

import { getProviderStateForNormalized, normalizeTaskState } from "../../tasking/task-state-mapping.js";
import {
  createDefaultWorkspaceConfig,
  parseWorkspaceConfig,
  runnerForAction,
  runnerForActionAndContinuation,
  runnerSessionRoleForAction,
  runnerTuningValue,
  stringifyWorkspaceConfig,
} from "../config.js";

describe("workspace config", () => {
  test("round-trips default file task config", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.workspace.name).toBe("foo");
    expect(parsed.taskSystem.type).toBe("file");
    expect(parsed.runner.execution).toEqual({
      type: "opencode",
      model: "openai/gpt-5.5",
      variant: "high",
      timeoutMs: 3_600_000,
    });
    expect(parsed.runner.reviewer).toEqual({
      type: "claude",
      model: "claude-opus-4-8",
      effort: "high",
      timeoutMs: 3_600_000,
    });
    expect(parsed.reviewer.agentPrefix).toBe("[review agent] ");
    expect(parsed.cron).toEqual({ enabled: false, jobsDir: "cron" });
    expect(parsed.agentTaskCreation).toEqual({ enabled: false });
    expect(parsed.deployment).toEqual({ minRetryIntervalMinutes: 10, maxRetryIntervalMinutes: 180 });
    expect(parsed.scheduler.workerConcurrency).toBe(4);
    expect(parsed.http.port).toBe(8765);
  });

  test("round-trips default Linear agent-created label", () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.taskSystem.linear!.agentCreatedLabel).toBe("Agent Created");
  });

  test("requires deployment max retry interval to be at least the min interval", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    config.deployment.minRetryIntervalMinutes = 60;
    config.deployment.maxRetryIntervalMinutes = 10;

    expect(() => parseWorkspaceConfig(stringifyWorkspaceConfig(config))).toThrow("maxRetryIntervalMinutes");
  });

  test("parses deployable state mappings for file and Linear task systems", () => {
    const fileConfig = createDefaultWorkspaceConfig("foo", "file");
    const linearConfig = createDefaultWorkspaceConfig("foo", "linear");

    expect(parseWorkspaceConfig(stringifyWorkspaceConfig(fileConfig)).taskSystem.file!.states.deployable).toEqual(["deployable"]);
    expect(parseWorkspaceConfig(stringifyWorkspaceConfig(linearConfig)).taskSystem.linear!.states.deployable).toEqual(["Ready to Deploy"]);
    expect(normalizeTaskState(linearConfig, "Ready to Deploy")).toBe("deployable");
    expect(getProviderStateForNormalized(linearConfig, "deployable")).toBe("Ready to Deploy");
  });

  test("routes review and deployment to execution and reviewer to reviewer runner", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");

    expect(runnerForAction(config, "review")).toEqual(config.runner.execution);
    expect(runnerForAction(config, "deployment")).toEqual(config.runner.execution);
    expect(runnerForAction(config, "reviewer")).toEqual(config.runner.reviewer);
    expect(runnerSessionRoleForAction("execution")).toBe("implementation");
    expect(runnerSessionRoleForAction("review")).toBe("implementation");
    expect(runnerSessionRoleForAction("deployment")).toBe("deployment");
    expect(runnerSessionRoleForAction("reviewer")).toBe("reviewer");
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

  test("defaults Linear excludeLabels to an empty list", () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.taskSystem.linear!.excludeLabels).toEqual([]);
  });

  test("round-trips configured Linear excludeLabels", () => {
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.taskSystem.linear!.excludeLabels = ["agent:disabled"];

    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.taskSystem.linear!.excludeLabels).toEqual(["agent:disabled"]);
  });

  test("parses codex execution and reviewer runner configs", () => {
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
  execution:
    type: codex
    model: gpt-5.5
    effort: high
    timeoutMs: 1800000
  reviewer:
    type: codex
    model: gpt-5.5
    effort: medium
    timeoutMs: 600000
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
      type: "codex",
      model: "gpt-5.5",
      effort: "high",
      timeoutMs: 1_800_000,
    });
    expect(parsed.runner.reviewer).toEqual({
      type: "codex",
      model: "gpt-5.5",
      effort: "medium",
      timeoutMs: 600_000,
    });
  });

  test("coerces unknown effort values to 'high' so stale configs still boot", () => {
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
  execution:
    type: codex
    model: gpt-5.5
    effort: minimal
    timeoutMs: 1800000
  reviewer:
    type: claude
    model: claude-opus-4-7
    effort: xhigh
    timeoutMs: 600000
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

    // Codex's user-facing grade set is [low, medium, high, xhigh] — "minimal"
    // (in the broader CLI schema but never surfaced in the model picker) is
    // coerced to "high" so old configs still boot.
    expect(parsed.runner.execution).toMatchObject({ type: "codex", effort: "high" });
    // Claude's user-facing grade set is [low, medium, high, max] — "xhigh"
    // (previously accepted by --effort but no longer in the curated set) is
    // coerced to "high".
    expect(parsed.runner.reviewer).toMatchObject({ type: "claude", effort: "high" });
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

  test("parses optional claude maxBudgetUsd on execution and reviewer runners", () => {
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
  execution:
    type: claude
    model: claude-opus-4-7
    effort: max
    timeoutMs: 3600000
    maxBudgetUsd: 100
  reviewer:
    type: claude
    model: claude-opus-4-7
    effort: high
    timeoutMs: 3600000
    maxBudgetUsd: 50
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
      model: "claude-opus-4-7",
      effort: "max",
      timeoutMs: 3_600_000,
      maxBudgetUsd: 100,
    });
    expect(parsed.runner.reviewer).toEqual({
      type: "claude",
      model: "claude-opus-4-7",
      effort: "high",
      timeoutMs: 3_600_000,
      maxBudgetUsd: 50,
    });
  });

  test("omits maxBudgetUsd when not configured", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.runner.execution).not.toHaveProperty("maxBudgetUsd");
    expect(parsed.runner.reviewer).not.toHaveProperty("maxBudgetUsd");
  });

  test("rejects non-positive maxBudgetUsd values", () => {
    const yamlWithBudget = (budget: string) => `
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
  execution:
    type: claude
    model: claude-opus-4-7
    effort: high
    timeoutMs: 3600000
    maxBudgetUsd: ${budget}
  reviewer:
    type: claude
    model: claude-opus-4-7
    effort: high
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
`;

    expect(() => parseWorkspaceConfig(yamlWithBudget("-1"))).toThrow(/maxBudgetUsd/);
    expect(() => parseWorkspaceConfig(yamlWithBudget("0"))).toThrow(/maxBudgetUsd/);
    expect(() => parseWorkspaceConfig(yamlWithBudget('"not-a-number"'))).toThrow(/maxBudgetUsd/);
  });

  const yamlWithRunner = (runnerBlock: string): string => `
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
${runnerBlock}
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
`;

  test("accepts optional continuationEffort on claude execution and reviewer runners", () => {
    const parsed = parseWorkspaceConfig(
      yamlWithRunner(`  execution:
    type: claude
    model: claude-opus-4-8
    effort: max
    continuationEffort: high
    timeoutMs: 3600000
  reviewer:
    type: claude
    model: claude-opus-4-8
    effort: max
    continuationEffort: medium
    timeoutMs: 3600000`),
    );

    expect(parsed.runner.execution).toMatchObject({ type: "claude", effort: "max", continuationEffort: "high" });
    expect(parsed.runner.reviewer).toMatchObject({ type: "claude", effort: "max", continuationEffort: "medium" });
  });

  test("accepts optional continuationEffort on codex runners", () => {
    const parsed = parseWorkspaceConfig(
      yamlWithRunner(`  execution:
    type: codex
    model: gpt-5.5
    effort: xhigh
    continuationEffort: medium
    timeoutMs: 3600000
  reviewer:
    type: codex
    model: gpt-5.5
    effort: high
    timeoutMs: 3600000`),
    );

    expect(parsed.runner.execution).toMatchObject({ type: "codex", effort: "xhigh", continuationEffort: "medium" });
    expect(parsed.runner.reviewer).toMatchObject({ type: "codex", effort: "high" });
    expect(parsed.runner.reviewer).not.toHaveProperty("continuationEffort");
  });

  test("accepts optional continuationVariant on opencode runners", () => {
    const parsed = parseWorkspaceConfig(
      yamlWithRunner(`  execution:
    type: opencode
    model: openai/gpt-5.5
    variant: high
    continuationVariant: low
    timeoutMs: 3600000
  reviewer:
    type: opencode
    model: openai/gpt-5.5
    variant: high
    timeoutMs: 3600000`),
    );

    expect(parsed.runner.execution).toMatchObject({ type: "opencode", variant: "high", continuationVariant: "low" });
    expect(parsed.runner.reviewer).not.toHaveProperty("continuationVariant");
  });

  test("rejects unknown continuationEffort values", () => {
    expect(() =>
      parseWorkspaceConfig(
        yamlWithRunner(`  execution:
    type: claude
    model: claude-opus-4-8
    effort: max
    continuationEffort: ultra
    timeoutMs: 3600000
  reviewer:
    type: claude
    model: claude-opus-4-8
    effort: max
    timeoutMs: 3600000`),
      ),
    ).toThrow();
  });

  test("omits continuation tuning when not configured", () => {
    const config = createDefaultWorkspaceConfig("foo", "file");
    const parsed = parseWorkspaceConfig(stringifyWorkspaceConfig(config));

    expect(parsed.runner.execution).not.toHaveProperty("continuationVariant");
    expect(parsed.runner.reviewer).not.toHaveProperty("continuationEffort");
  });

  describe("runnerForActionAndContinuation", () => {
    const claudeConfig = () => {
      const config = createDefaultWorkspaceConfig("foo", "file");
      config.runner.execution = { type: "claude", model: "claude-opus-4-8", effort: "max", continuationEffort: "high", timeoutMs: 3_600_000 };
      config.runner.reviewer = { type: "claude", model: "claude-opus-4-8", effort: "max", continuationEffort: "medium", timeoutMs: 3_600_000 };
      return config;
    };

    test("uses continuationEffort for review and reviewer continuations", () => {
      const config = claudeConfig();

      expect(runnerTuningValue(runnerForActionAndContinuation(config, "review", true))).toBe("high");
      expect(runnerTuningValue(runnerForActionAndContinuation(config, "reviewer", true))).toBe("medium");
    });

    test("falls back to base effort when the dispatch is not a continuation", () => {
      const config = claudeConfig();

      expect(runnerTuningValue(runnerForActionAndContinuation(config, "execution", false))).toBe("max");
      expect(runnerTuningValue(runnerForActionAndContinuation(config, "reviewer", false))).toBe("max");
    });

    test("falls back to base effort when continuationEffort is omitted", () => {
      const config = createDefaultWorkspaceConfig("foo", "file");
      config.runner.execution = { type: "claude", model: "claude-opus-4-8", effort: "max", timeoutMs: 3_600_000 };

      expect(runnerTuningValue(runnerForActionAndContinuation(config, "review", true))).toBe("max");
    });

    test("uses continuationVariant for opencode continuations and falls back otherwise", () => {
      const config = createDefaultWorkspaceConfig("foo", "file");
      config.runner.execution = { type: "opencode", model: "openai/gpt-5.5", variant: "high", continuationVariant: "low", timeoutMs: 3_600_000 };

      expect(runnerTuningValue(runnerForActionAndContinuation(config, "review", true))).toBe("low");
      expect(runnerTuningValue(runnerForActionAndContinuation(config, "execution", false))).toBe("high");
    });

    test("uses continuationEffort for codex continuations and falls back otherwise", () => {
      const config = createDefaultWorkspaceConfig("foo", "file");
      config.runner.execution = { type: "codex", model: "gpt-5.5", effort: "xhigh", continuationEffort: "medium", timeoutMs: 3_600_000 };

      expect(runnerTuningValue(runnerForActionAndContinuation(config, "review", true))).toBe("medium");
      expect(runnerTuningValue(runnerForActionAndContinuation(config, "review", false))).toBe("xhigh");
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
