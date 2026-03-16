import { spawn } from "node:child_process";

import type { AgentRunRequest, AgentRunResult } from "./domain.js";
import { isoNow } from "./lib/time.js";

type AgentRunLineCallbacks = {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

export interface AgentRunner {
  invoke(request: AgentRunRequest): Promise<AgentRunResult>;
}

export type CapturedAgentRunResult = AgentRunResult & {
  stdout: string;
  stderr: string;
};

export class OpenCodeRunner implements AgentRunner {
  constructor(
    private readonly model: string,
    private readonly variant: string,
  ) {}

  async invoke(request: AgentRunRequest & { abortSignal?: AbortSignal } & AgentRunLineCallbacks): Promise<CapturedAgentRunResult> {
    const startedAt = isoNow();
    const command = process.env.FOREMAN_OPENCODE_BIN ?? "opencode";
    const args = [
      "run",
      "--model",
      this.model,
      "--variant",
      this.variant,
      "--non-interactive",
    ];

    const child = spawn(command, args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let signal: string | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;

    const abortHandler = (): void => {
      child.kill("SIGTERM");
    };

    request.abortSignal?.addEventListener("abort", abortHandler, { once: true });

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
        child.kill("SIGTERM");
      }, request.timeoutMs);
    }

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, closeSignal) => {
        signal = closeSignal;
        resolve(code);
      });
    }).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
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

export const parseWorkerResult = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Worker output was empty");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/<agent-result>\s*([\s\S]*?)\s*<\/agent-result>/);
    if (!match?.[1]) {
      throw new Error("Worker output did not contain a valid <agent-result> block");
    }

    return JSON.parse(match[1]);
  }
};
