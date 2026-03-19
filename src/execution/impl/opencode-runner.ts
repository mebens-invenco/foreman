import { spawn } from "node:child_process";

import { isoNow } from "../../lib/time.js";
import type { AgentRunner, AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";

const forceKillAfterMs = 1_000;
const useProcessGroups = process.platform !== "win32";

export class OpenCodeRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly variant: string,
  ) {}

  async invoke(request: AgentRunnerInvokeRequest): Promise<CapturedAgentRunResult> {
    const startedAt = isoNow();
    const command = process.env.FOREMAN_OPENCODE_BIN ?? "opencode";
    const args = ["run", "--model", this.model, "--variant", this.variant];

    const child = spawn(command, args, {
      cwd: request.cwd,
      detached: useProcessGroups,
      env: { ...process.env, ...request.env },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let signal: string | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let forcedKillTimeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    let closed = false;
    let terminateRequested = false;

    const sendSignal = (requestedSignal: NodeJS.Signals): void => {
      if (closed) {
        return;
      }

      try {
        if (useProcessGroups && child.pid) {
          process.kill(-child.pid, requestedSignal);
          return;
        }

        child.kill(requestedSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          return;
        }

        throw error;
      }
    };

    const terminateChild = (): void => {
      if (terminateRequested) {
        return;
      }

      terminateRequested = true;
      sendSignal("SIGTERM");
      forcedKillTimeout = setTimeout(() => {
        if (!closed) {
          sendSignal("SIGKILL");
        }
      }, forceKillAfterMs);
    };

    const abortHandler = (): void => {
      terminateChild();
    };

    if (request.abortSignal?.aborted) {
      terminateChild();
    } else {
      request.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdin.end(request.prompt);
    const emitLines = (chunk: string, buffer: string, callback?: (line: string) => void): string => {
      const combined = `${buffer}${chunk}`;
      const parts = combined.split(/\r?\n/);
      const remainder = parts.pop() ?? "";
      if (callback) {
        for (const part of parts) {
          callback(part);
        }
      }
      return remainder;
    };
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      stdoutLineBuffer = emitLines(text, stdoutLineBuffer, request.onStdoutLine);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      stderrLineBuffer = emitLines(text, stderrLineBuffer, request.onStderrLine);
    });

    if (request.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChild();
      }, request.timeoutMs);
    }

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, closeSignal) => {
        closed = true;
        signal = closeSignal;
        resolve(code);
      });
    }).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forcedKillTimeout) {
        clearTimeout(forcedKillTimeout);
      }
      request.abortSignal?.removeEventListener("abort", abortHandler);
      if (stdoutLineBuffer) {
        request.onStdoutLine?.(stdoutLineBuffer);
      }
      if (stderrLineBuffer) {
        request.onStderrLine?.(stderrLineBuffer);
      }
    });

    return {
      exitCode: timedOut ? null : exitCode,
      signal,
      startedAt,
      finishedAt: isoNow(),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdout,
      stderr,
    };
  }
}
