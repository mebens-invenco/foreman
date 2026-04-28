import { randomUUID } from "node:crypto";

import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { normalizeClaudeJsonOutput } from "./json-output.js";
import { runAgentProcess } from "./run-agent-process.js";

export class ClaudeRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly effort: string,
  ) {}

  async invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult> {
    const nativeSessionId = request.nativeSessionId ?? randomUUID();
    return runAgentProcess({
      command: process.env.FOREMAN_CLAUDE_BIN ?? "claude",
      args: [
        "-p",
        "--dangerously-skip-permissions",
        "--model",
        this.model,
        "--effort",
        this.effort,
        "--output-format",
        "json",
        ...(request.nativeSessionId ? ["--resume", nativeSessionId] : ["--session-id", nativeSessionId]),
      ],
      request: { ...request, nativeSessionId },
      normalizeStdout: (stdout) => {
        const normalized = normalizeClaudeJsonOutput(stdout);
        return { stdout: normalized.stdout, nativeSessionId: normalized.nativeSessionId ?? nativeSessionId };
      },
    });
  }
}
