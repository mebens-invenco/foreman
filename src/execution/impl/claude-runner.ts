import { randomUUID } from "node:crypto";

import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { normalizeClaudeActivityLine, normalizeClaudeJsonOutput } from "./claude-output.js";
import { runAgentProcess } from "./run-agent-process.js";

export class ClaudeRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly effort: string,
    private readonly maxBudgetUsd?: number,
  ) {}

  async invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult> {
    if (request.nativeSessionId) {
      return this.run(request, request.nativeSessionId, true);
    }

    return this.run(request, randomUUID(), false);
  }

  private run(request: AgentRunnerInvokeRequest, nativeSessionId: string, resume: boolean): Promise<CapturedAgentRunResult> {
    return runAgentProcess({
      command: process.env.FOREMAN_CLAUDE_BIN ?? "claude",
      args: [
        "-p",
        "--dangerously-skip-permissions",
        // Move per-machine sections (cwd, env, git status) out of the cached system
        // prompt prefix to improve cross-attempt cache reuse.
        "--exclude-dynamic-system-prompt-sections",
        "--model",
        this.model,
        "--effort",
        this.effort,
        "--output-format",
        "json",
        ...(this.maxBudgetUsd !== undefined ? ["--max-budget-usd", String(this.maxBudgetUsd)] : []),
        ...(resume ? ["--resume", nativeSessionId] : ["--session-id", nativeSessionId]),
      ],
      request: { ...request, nativeSessionId },
      normalizeStdout: (stdout) => {
        const normalized = normalizeClaudeJsonOutput(stdout);
        return {
          ...normalized,
          stdout: normalized.stdout,
          nativeSessionId: normalized.nativeSessionId ?? nativeSessionId,
        };
      },
      normalizeStdoutLine: normalizeClaudeActivityLine,
    });
  }
}
