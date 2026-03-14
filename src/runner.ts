import { spawn } from "node:child_process";

import type { AgentRunRequest, AgentRunResult } from "./domain.js";
import { isoNow } from "./lib/time.js";

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

  async invoke(request: AgentRunRequest & { abortSignal?: AbortSignal }): Promise<CapturedAgentRunResult> {
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
    let signal: string | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;

    const abortHandler = (): void => {
      child.kill("SIGTERM");
    };

    request.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    child.stdin.end(request.prompt);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
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
