import { spawn } from "node:child_process";

import { ForemanError } from "./errors.js";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export const exec = async (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<ExecResult> => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";
  let timeout: NodeJS.Timeout | undefined;

  if (options.input !== undefined) {
    child.stdin.write(options.input);
    child.stdin.end();
  }

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }
  }).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });

  if (exitCode !== 0) {
    throw new ForemanError(
      "process_failed",
      `${command} ${args.join(" ")} failed with exit code ${exitCode}: ${stderr || stdout}`.trim(),
      500,
    );
  }

  return { stdout, stderr, exitCode };
};
