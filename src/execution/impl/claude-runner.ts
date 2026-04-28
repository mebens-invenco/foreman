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
    if (request.nativeSessionId) {
      const resumed = await this.run(request, request.nativeSessionId, true);
      if (this.shouldStartFreshAfterResumeFailure(request, resumed)) {
        request.onStderrLine?.(`[foreman] Claude session ${request.nativeSessionId} could not be resumed; starting a fresh session.`);
        return this.run(request, randomUUID(), false);
      }

      return resumed;
    }

    return this.run(request, randomUUID(), false);
  }

  private run(request: AgentRunnerInvokeRequest, nativeSessionId: string, resume: boolean): Promise<CapturedAgentRunResult> {
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
        ...(resume ? ["--resume", nativeSessionId] : ["--session-id", nativeSessionId]),
      ],
      request: { ...request, nativeSessionId },
      normalizeStdout: (stdout) => {
        const normalized = normalizeClaudeJsonOutput(stdout);
        return { stdout: normalized.stdout, nativeSessionId: normalized.nativeSessionId ?? nativeSessionId };
      },
    });
  }

  private shouldStartFreshAfterResumeFailure(request: AgentRunnerInvokeRequest, result: CapturedAgentRunResult): boolean {
    return !request.abortSignal?.aborted && result.signal === null && result.exitCode !== null && result.exitCode !== 0;
  }
}
