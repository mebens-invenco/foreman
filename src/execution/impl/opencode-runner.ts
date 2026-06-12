import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { normalizeOpenCodeJsonOutput } from "./opencode-output.js";
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
        // Foreman workers run unattended over a closed stdin, so an interactive
        // permission prompt can never be answered. Without this flag opencode
        // auto-rejects any permission whose policy is `ask` and disposes the
        // session — notably `external_directory`, which fires the moment the run
        // touches a cwd opencode does not recognize as a project (e.g. `foreman
        // eval`'s throwaway repo dir), aborting before the model emits its final
        // `<agent-result>`. Mirrors the claude runner's --dangerously-skip-permissions.
        "--dangerously-skip-permissions",
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
