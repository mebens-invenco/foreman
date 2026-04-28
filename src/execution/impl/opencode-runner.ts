import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { normalizeOpenCodeJsonOutput } from "./json-output.js";
import { runAgentProcess } from "./run-agent-process.js";

export class OpenCodeRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly variant: string,
  ) {}

  async invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult> {
    if (request.nativeSessionId) {
      return this.run(request, request.nativeSessionId);
    }

    return this.run(request);
  }

  private run(request: AgentRunnerInvokeRequest, nativeSessionId?: string): Promise<CapturedAgentRunResult> {
    return runAgentProcess({
      command: process.env.FOREMAN_OPENCODE_BIN ?? "opencode",
      args: [
        "run",
        "--model",
        this.model,
        "--variant",
        this.variant,
        "--format",
        "json",
        ...(nativeSessionId ? ["--session", nativeSessionId] : []),
      ],
      request,
      normalizeStdout: normalizeOpenCodeJsonOutput,
    });
  }
}
