import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { runAgentProcess } from "./run-agent-process.js";

export class ClaudeRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly effort: string,
  ) {}

  async invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult> {
    return runAgentProcess({
      command: process.env.FOREMAN_CLAUDE_BIN ?? "claude",
      args: ["-p", "--dangerously-skip-permissions", "--model", this.model, "--effort", this.effort],
      request,
    });
  }
}
