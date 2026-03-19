import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { OpenCodeRunner } from "../index.js";
import { createTempDir } from "../../test-support/helpers.js";

const cleanupDirs: string[] = [];
const originalOpencodeBin = process.env.FOREMAN_OPENCODE_BIN;

afterEach(async () => {
  if (originalOpencodeBin === undefined) {
    delete process.env.FOREMAN_OPENCODE_BIN;
  } else {
    process.env.FOREMAN_OPENCODE_BIN = originalOpencodeBin;
  }

  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("OpenCodeRunner abort handling", () => {
  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, "fake-opencode.js");
    await fs.writeFile(
      scriptPath,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { setInterval(() => {}, 1000); });\n",
      { mode: 0o755 },
    );
    process.env.FOREMAN_OPENCODE_BIN = scriptPath;

    const abortController = new AbortController();
    const runner = new OpenCodeRunner("openai/gpt-5.4", "high");
    const runPromise = runner.invoke({
      attemptId: "attempt-1",
      cwd: tempDir,
      env: {},
      prompt: "test prompt",
      timeoutMs: 60_000,
      abortSignal: abortController.signal,
    });

    setTimeout(() => {
      abortController.abort();
    }, 20);

    const result = await runPromise;
    expect(result.signal).toBe("SIGKILL");
  }, 10_000);

  test("kills descendant processes that keep stdio open after abort", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, "fake-opencode.js");
    await fs.writeFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', \"setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'inherit', 'inherit'] });",
        "process.stdin.resume();",
        "process.stdin.on('end', () => { setInterval(() => {}, 1000); });",
        "process.on('SIGTERM', () => { process.exit(0); });",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.FOREMAN_OPENCODE_BIN = scriptPath;

    const abortController = new AbortController();
    const runner = new OpenCodeRunner("openai/gpt-5.4", "high");
    const startedAt = Date.now();
    const runPromise = runner.invoke({
      attemptId: "attempt-2",
      cwd: tempDir,
      env: {},
      prompt: "test prompt",
      timeoutMs: 60_000,
      abortSignal: abortController.signal,
    });

    setTimeout(() => {
      abortController.abort();
    }, 20);

    const result = await runPromise;
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  }, 10_000);
});
