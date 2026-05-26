import { spawn } from "node:child_process";
import path from "node:path";

import { isoNow } from "../../lib/time.js";
import type { AgentRunnerInvokeRequest, CapturedAgentRunResult } from "../agent-runner.js";
import type { NormalizedRunnerActivity } from "../../repos/attempt-activity-repo.js";
import type { NormalizedJsonOutput } from "./json-output.js";

const forceKillAfterMs = 1_000;
const useProcessGroups = process.platform !== "win32";

/**
 * Per-line normalizer. Runners pass one of these so a raw JSON line can be
 * turned into zero or more {@link NormalizedRunnerActivity}s; the activity
 * callback drains them in line order. Returning `null`/`undefined` means
 * the line carried no activity; throwing is **not** fatal — the line is
 * dropped and processing continues (live observability is best-effort).
 */
export type LineActivityNormalizer = (
  line: string,
) => NormalizedRunnerActivity | NormalizedRunnerActivity[] | null | undefined;

export const runAgentProcess = async (input: {
  command: string;
  args: string[];
  request: AgentRunnerInvokeRequest;
  normalizeStdout?: (stdout: string) => NormalizedJsonOutput;
  normalizeStdoutLine?: LineActivityNormalizer;
  normalizeStderrLine?: LineActivityNormalizer;
}): Promise<CapturedAgentRunResult> => {
  const startedAt = isoNow();
  const env = { ...process.env, ...input.request.env };
  if (process.platform !== "win32") {
    env.PWD = path.resolve(input.request.cwd);
  }

  const child = spawn(input.command, input.args, {
    cwd: input.request.cwd,
    detached: useProcessGroups,
    env,
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

  const emitActivities = (line: string, normalizer?: LineActivityNormalizer): void => {
    if (!normalizer || !input.request.onActivity) {
      return;
    }
    // Best-effort: a normalizer that throws on a malformed line must not
    // crash the runner. Live observability is non-fatal by design.
    let result: NormalizedRunnerActivity | NormalizedRunnerActivity[] | null | undefined;
    try {
      result = normalizer(line);
    } catch {
      return;
    }
    if (!result) {
      return;
    }
    const activities = Array.isArray(result) ? result : [result];
    for (const activity of activities) {
      try {
        input.request.onActivity(activity);
      } catch {
        // ignore — observer failures cannot abort the runner
      }
    }
  };

  const emitLines = (
    chunk: string,
    buffer: string,
    callback?: (line: string) => void,
    normalizer?: LineActivityNormalizer,
  ): string => {
    const combined = `${buffer}${chunk}`;
    const parts = combined.split(/\r?\n/);
    const remainder = parts.pop() ?? "";
    for (const part of parts) {
      if (callback) {
        callback(part);
      }
      emitActivities(part, normalizer);
    }
    return remainder;
  };

  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout += text;
    stdoutLineBuffer = emitLines(text, stdoutLineBuffer, input.request.onStdoutLine, input.normalizeStdoutLine);
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr += text;
    stderrLineBuffer = emitLines(text, stderrLineBuffer, input.request.onStderrLine, input.normalizeStderrLine);
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
      emitActivities(stdoutLineBuffer, input.normalizeStdoutLine);
    }
    if (stderrLineBuffer) {
      input.request.onStderrLine?.(stderrLineBuffer);
      emitActivities(stderrLineBuffer, input.normalizeStderrLine);
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
