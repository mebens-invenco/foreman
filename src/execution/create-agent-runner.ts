import type { ActionType, Task, TaskRunnerRoleOverride } from "../domain/index.js";
import { ForemanError } from "../lib/errors.js";
import type { WorkspaceConfig, WorkspaceRunnerConfig } from "../workspace/config.js";
import {
  CLAUDE_EFFORT_VALUES,
  CODEX_EFFORT_VALUES,
  runnerForAction,
  runnerRoleForAction,
} from "../workspace/config.js";
import type { AgentRunner } from "./agent-runner.js";
import { ClaudeRunner } from "./impl/claude-runner.js";
import { CodexRunner } from "./impl/codex-runner.js";
import { OpenCodeRunner } from "./impl/opencode-runner.js";

const createProviderRunner = (config: WorkspaceRunnerConfig): AgentRunner => {
  if (config.type === "opencode") {
    return new OpenCodeRunner(config.model, config.variant);
  }

  if (config.type === "claude") {
    return new ClaudeRunner(config.model, config.effort, config.maxBudgetUsd);
  }

  if (config.type === "codex") {
    return new CodexRunner(config.model, config.effort);
  }

  throw new Error(`Unsupported runner type: ${String((config as { type?: unknown }).type)}`);
};

const isAllowedTuning = (provider: WorkspaceRunnerConfig["type"], value: string): boolean => {
  if (provider === "claude") {
    return (CLAUDE_EFFORT_VALUES as readonly string[]).includes(value);
  }
  if (provider === "codex") {
    return (CODEX_EFFORT_VALUES as readonly string[]).includes(value);
  }
  // opencode accepts any non-empty variant value.
  return value.length > 0;
};

const applyRoleOverride = (
  baseConfig: WorkspaceRunnerConfig,
  override: TaskRunnerRoleOverride | undefined,
): WorkspaceRunnerConfig => {
  if (!override) {
    return baseConfig;
  }

  const overridden: WorkspaceRunnerConfig = { ...baseConfig };
  if (override.model !== undefined) {
    if (override.model.trim().length === 0) {
      throw new ForemanError("invalid_runner_override", `Runner override model must not be empty for ${baseConfig.type}.`);
    }
    overridden.model = override.model;
  }

  if (baseConfig.type === "opencode" && override.tuning !== undefined) {
    if (override.tuning.trim().length === 0) {
      throw new ForemanError("invalid_runner_override", "Runner override tuning must not be empty for opencode.");
    }
    (overridden as Extract<WorkspaceRunnerConfig, { type: "opencode" }>).variant = override.tuning;
  }

  if ((baseConfig.type === "claude" || baseConfig.type === "codex") && override.tuning !== undefined) {
    if (!isAllowedTuning(baseConfig.type, override.tuning)) {
      const allowed = baseConfig.type === "claude" ? CLAUDE_EFFORT_VALUES.join(", ") : CODEX_EFFORT_VALUES.join(", ");
      throw new ForemanError(
        "invalid_runner_override",
        `Invalid runner override tuning '${override.tuning}' for ${baseConfig.type}. Allowed: ${allowed}.`,
      );
    }
    (overridden as Extract<WorkspaceRunnerConfig, { type: "claude" | "codex" }>).effort = override.tuning as never;
  }

  return overridden;
};

export const resolveRunnerConfigForAction = (
  config: WorkspaceConfig,
  action: ActionType,
  task?: Pick<Task, "runnerOverride"> | null,
): WorkspaceRunnerConfig => {
  const baseConfig = runnerForAction(config, action);
  const role = runnerRoleForAction(action);
  const override = task?.runnerOverride?.[role];
  return applyRoleOverride(baseConfig, override);
};

export const createAgentRunner = (input: {
  config: WorkspaceConfig;
  action: ActionType;
  task?: Pick<Task, "runnerOverride"> | null;
}): AgentRunner => {
  return createProviderRunner(resolveRunnerConfigForAction(input.config, input.action, input.task));
};
