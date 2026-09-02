import { execFile } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import { normalizeCodexJsonOutput } from "./codex-output.js";
import { runAgentProcess } from "./run-agent-process.js";

const execFileAsync = promisify(execFile);

// Codex CLI sandbox config override applied to every invocation. Resume mode
// (`codex exec resume`) does not accept the `-s/--sandbox` flag, so we pass
// the equivalent policy via the dotted-path TOML override on every call to
// keep behaviour identical between fresh and resumed runs without depending
// on `~/.codex/config.toml`. `workspace-write` confines edits to the task
// worktree (and conventionally writable system paths like /tmp); broader
// `disk-full-write-access` is intentionally not used.
const CODEX_SANDBOX_OVERRIDE = 'sandbox_mode="workspace-write"';

// `workspace-write` denies network by default, which blocks `git push` and any
// dependency fetch the task needs.
const CODEX_NETWORK_OVERRIDE = "sandbox_workspace_write.network_access=true";

// Clears every `[mcp_servers.*]` entry that would otherwise load from
// `~/.codex/config.toml`. Passed as a `-c` TOML override (consistent with how
// model/effort/sandbox are injected) so a single invocation loads ZERO MCP
// servers — the Codex analogue of claude's `--strict-mcp-config`. Used for pure
// grading calls (the eval judge) that need no tools and must not trigger
// per-call MCP auth prompts. We override the table rather than pass
// `--ignore-user-config` so unrelated user config (profiles, env policy) stays
// intact.
const CODEX_EXCLUDE_MCP_OVERRIDE = "mcp_servers={}";

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
    // When true, override `mcp_servers` to an empty table so the CLI loads ZERO
    // MCP servers (see CODEX_EXCLUDE_MCP_OVERRIDE). Default off — normal worker
    // runs keep their configured MCP servers.
    private readonly excludeMcp: boolean = false,
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

  // Tasks run in a linked git worktree whose real git directory lives under the
  // origin clone (`<repo>/.git/worktrees/<name>`), outside the sandbox's cwd
  // root — without this, git cannot take its index lock and no commit is
  // possible. Resolving to the common dir also covers the objects and refs a
  // commit writes. Unresolvable (not a repo, no git) leaves the roots untouched.
  private async resolveGitCommonDir(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd });
      const gitCommonDir = stdout.trim();
      return gitCommonDir ? resolvePath(cwd, gitCommonDir) : undefined;
    } catch {
      return undefined;
    }
  }

  private async run(
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
    const gitCommonDir = await this.resolveGitCommonDir(request.cwd);
    const sharedConfigArgs = [
      "-c",
      CODEX_SANDBOX_OVERRIDE,
      "-c",
      CODEX_NETWORK_OVERRIDE,
      ...(gitCommonDir ? ["-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(gitCommonDir)}]`] : []),
      "-c",
      `model=${JSON.stringify(this.model)}`,
      "-c",
      `model_reasoning_effort=${JSON.stringify(this.effort)}`,
      ...(this.excludeMcp ? ["-c", CODEX_EXCLUDE_MCP_OVERRIDE] : []),
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
