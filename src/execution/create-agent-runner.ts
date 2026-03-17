import type { WorkspaceConfig } from "../workspace/config.js";
import type { AgentRunner } from "./agent-runner.js";
import { OpenCodeRunner } from "./impl/opencode-runner.js";

export const createAgentRunner = (input: { config: WorkspaceConfig }): AgentRunner => {
  if (input.config.runner.type === "opencode") {
    return new OpenCodeRunner(input.config.runner.model, input.config.runner.variant);
  }

  throw new Error(`Unsupported runner type: ${String((input.config.runner as { type?: unknown }).type)}`);
};
