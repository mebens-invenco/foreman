import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { normalizeCodexJsonOutput } from "./codex-output.js";
import { runAgentProcess } from "./run-agent-process.js";

// Codex CLI sandbox config override applied to every invocation. Resume mode
// (`codex exec resume`) does not accept the `-s/--sandbox` flag, so we pass
// the equivalent policy via the dotted-path TOML override on every call to
// keep behaviour identical between fresh and resumed runs without depending
// on `~/.codex/config.toml`. `workspace-write` confines edits to the task
// worktree (and conventionally writable system paths like /tmp); broader
// `disk-full-write-access` is intentionally not used.
const CODEX_SANDBOX_OVERRIDE = 'sandbox_mode="workspace-write"';

export class CodexRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly effort: string,
  ) {}

  async invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult> {
    if (request.nativeSessionId) {
      return this.run(request, request.nativeSessionId, true);
    }

    return this.run(request, undefined, false);
  }

  private run(
    request: AgentRunnerInvokeRequest,
    nativeSessionId: string | undefined,
    resume: boolean,
  ): Promise<CapturedAgentRunResult> {
    // Codex CLI argument layout. The positional `-` tells codex to read the
    // prompt from stdin so the existing `runAgentProcess` plumbing (which pipes
    // `request.prompt` into stdin) keeps working unchanged. The model and effort
    // are passed via `-c key="value"` overrides because codex parses each `-c`
    // value as TOML.
    const baseArgs = ["exec"];
    const sharedConfigArgs = ["-c", CODEX_SANDBOX_OVERRIDE, "-c", `model="${this.model}"`, "-c", `model_reasoning_effort="${this.effort}"`];

    const args = resume && nativeSessionId
      ? [...baseArgs, "resume", "--json", ...sharedConfigArgs, nativeSessionId, "-"]
      : [...baseArgs, "--json", ...sharedConfigArgs, "-"];

    return runAgentProcess({
      command: process.env.FOREMAN_CODEX_BIN ?? "codex",
      args,
      request,
      normalizeStdout: (stdout) => {
        const normalized = normalizeCodexJsonOutput(stdout);
        const resolvedSessionId = normalized.nativeSessionId ?? nativeSessionId;
        return {
          ...normalized,
          stdout: normalized.stdout,
          ...(resolvedSessionId ? { nativeSessionId: resolvedSessionId } : {}),
        };
      },
    });
  }
}
