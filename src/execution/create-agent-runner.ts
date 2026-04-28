import type { ActionType } from "../domain/index.js";
import type { WorkspaceConfig, WorkspaceRunnerConfig } from "../workspace/config.js";
import { runnerForAction } from "../workspace/config.js";
import type { AgentRunner } from "./agent-runner.js";
import { ClaudeRunner } from "./impl/claude-runner.js";
import { OpenCodeRunner } from "./impl/opencode-runner.js";

const createProviderRunner = (config: WorkspaceRunnerConfig): AgentRunner => {
  if (config.type === "opencode") {
    return new OpenCodeRunner(config.model, config.variant);
  }

  if (config.type === "claude") {
    return new ClaudeRunner(config.model, config.effort);
  }

  throw new Error(`Unsupported runner type: ${String((config as { type?: unknown }).type)}`);
};

export const resolveRunnerConfigForAction = (config: WorkspaceConfig, action: ActionType): WorkspaceRunnerConfig =>
  runnerForAction(config, action);

export const createAgentRunner = (input: { config: WorkspaceConfig; action: ActionType }): AgentRunner => {
  return createProviderRunner(resolveRunnerConfigForAction(input.config, input.action));
};
