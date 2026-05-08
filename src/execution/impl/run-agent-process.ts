import { spawn } from "node:child_process";

import { isoNow } from "../../lib/time.js";
import type { AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import type { NormalizedJsonOutput } from "./json-output.js";

const forceKillAfterMs = 1_000;
const useProcessGroups = process.platform !== "win32";

export const runAgentProcess = async (input: {
  command: string;
  args: string[];
  request: AgentRunnerInvokeRequest;
  normalizeStdout?: (stdout: string) => NormalizedJsonOutput;
}): Promise<CapturedAgentRunResult> => {
  const startedAt = isoNow();

  const child = spawn(input.command, input.args, {
    cwd: input.request.cwd,
    detached: useProcessGroups,
    env: { ...process.env, ...input.request.env },
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

  if (input.request.abortSignal?.aborted) {
    terminateChild();
  } else {
    input.request.abortSignal?.addEventListener("abort", abortHandler, { once: true });
  }

  child.stdin.end(input.request.prompt);

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
    stdoutLineBuffer = emitLines(text, stdoutLineBuffer, input.request.onStdoutLine);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    stderrLineBuffer = emitLines(text, stderrLineBuffer, input.request.onStderrLine);
  });

  if (input.request.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      terminateChild();
    }, input.request.timeoutMs);
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
    input.request.abortSignal?.removeEventListener("abort", abortHandler);
    if (stdoutLineBuffer) {
      input.request.onStdoutLine?.(stdoutLineBuffer);
    }
    if (stderrLineBuffer) {
      input.request.onStderrLine?.(stderrLineBuffer);
    }
  });

  const normalized = input.normalizeStdout?.(stdout);
  if (normalized?.warning) {
    input.request.onStderrLine?.(`[foreman] ${normalized.warning}`);
  }

  return {
    exitCode: timedOut ? null : exitCode,
    signal,
    timedOut,
    timeoutMs: timedOut ? input.request.timeoutMs : null,
    startedAt,
    finishedAt: isoNow(),
    stdoutBytes: Buffer.byteLength(normalized?.stdout ?? stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdout: normalized?.stdout ?? stdout,
    stderr,
    ...(normalized?.nativeSessionId ? { nativeSessionId: normalized.nativeSessionId } : {}),
    ...(normalized?.tokensUsed ? { tokensUsed: normalized.tokensUsed } : {}),
  };
};
