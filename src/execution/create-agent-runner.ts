import type { ActionType } from "../domain/index.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { AgentRunner } from "./agent-runner.js";
import { OpenCodeRunner } from "./impl/opencode-runner.js";

export const resolveRunnerConfigForAction = (config: WorkspaceConfig, action: ActionType): WorkspaceConfig["runner"] =>
  action === "reviewer" ? config.reviewer.runner : config.runner;

export const createAgentRunner = (input: { config: WorkspaceConfig; action: ActionType }): AgentRunner => {
  const runnerConfig = resolveRunnerConfigForAction(input.config, input.action);
  if (runnerConfig.type === "opencode") {
    return new OpenCodeRunner(runnerConfig.model, runnerConfig.variant);
  }

  throw new Error(`Unsupported runner type: ${String((runnerConfig as { type?: unknown }).type)}`);
};
