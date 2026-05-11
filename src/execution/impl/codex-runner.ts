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

// Codex thread ids are UUIDs (typically UUIDv7). Validating the shape before
// passing as a positional arg prevents option-shaped strings (e.g. "--last",
// "-c whatever") from being interpreted as flags by `codex exec resume`. The
// regex matches the canonical 8-4-4-4-12 hex form with hyphens, case-insensitive.
const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidCodexThreadId = (value: unknown): value is string =>
  typeof value === "string" && CODEX_THREAD_ID_PATTERN.test(value);

export class CodexRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly effort: string,
  ) {}

  async invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult> {
    if (request.nativeSessionId) {
      if (!isValidCodexThreadId(request.nativeSessionId)) {
        throw new Error(
          `Invalid Codex thread id (expected UUID, got ${JSON.stringify(request.nativeSessionId)})`,
        );
      }
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
    // are passed via `-c key=value` overrides because codex parses each `-c`
    // value as TOML. `JSON.stringify` produces a valid TOML basic string
    // (correctly escaping embedded quotes, backslashes, and newlines) so the
    // override stays well-formed even if the value contains TOML-special chars.
    // On resume, we insert `--` before the [SESSION_ID] positional so a
    // syntactically valid but option-shaped id can never be reinterpreted as a
    // flag by clap; the upstream validator in `invoke()` is the primary guard,
    // and `--` is defence in depth.
    const baseArgs = ["exec"];
    const sharedConfigArgs = [
      "-c",
      CODEX_SANDBOX_OVERRIDE,
      "-c",
      `model=${JSON.stringify(this.model)}`,
      "-c",
      `model_reasoning_effort=${JSON.stringify(this.effort)}`,
    ];

    const args = resume && nativeSessionId
      ? [...baseArgs, "resume", "--json", ...sharedConfigArgs, "--", nativeSessionId, "-"]
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
