import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { normalizeOpenCodeJsonOutput, redactRetryableOpenCodeErrorLine } from "./opencode-output.js";
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

  private async run(request: AgentRunnerInvokeRequest, nativeSessionId?: string): Promise<CapturedAgentRunResult> {
    const result = await runAgentProcess({
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
      request: {
        ...request,
        ...(request.onStdoutLine
          ? { onStdoutLine: (line: string) => request.onStdoutLine?.(redactRetryableOpenCodeErrorLine(line)) }
          : {}),
      },
      normalizeStdout: normalizeOpenCodeJsonOutput,
    });
    if (result.exitCode === 0 || result.signal || result.timedOut || request.abortSignal?.aborted) {
      const { retryableInterruption: _retryableInterruption, ...nonRetryableResult } = result;
      return nonRetryableResult;
    }
    if (!result.retryableInterruption) {
      return result;
    }

    return {
      ...result,
      stdout: result.retryableInterruption.summary,
      stdoutBytes: Buffer.byteLength(result.retryableInterruption.summary),
    };
  }
}
