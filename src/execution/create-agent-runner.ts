import type { WorkspaceConfig, WorkspaceRunnerConfig } from "../workspace/config.js";
import type { AgentRunner } from "./agent-runner.js";
import { runnerRoleForAction } from "../workspace/config.js";
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

export const createAgentRunner = (input: { config: WorkspaceConfig }): AgentRunner => {
  const runners = {
    execution: createProviderRunner(input.config.runner.execution),
    reviewer: createProviderRunner(input.config.runner.reviewer),
  } satisfies Record<"execution" | "reviewer", AgentRunner>;

  return {
    invoke(request) {
      return runners[runnerRoleForAction(request.action)].invoke(request);
    },
  };
};
