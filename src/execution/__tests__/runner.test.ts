import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { ClaudeRunner, OpenCodeRunner, createAgentRunner } from "../index.js";
import { createTempDir } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";

const cleanupDirs: string[] = [];
const originalOpencodeBin = process.env.FOREMAN_OPENCODE_BIN;
const originalClaudeBin = process.env.FOREMAN_CLAUDE_BIN;

const writeExecutableScript = async (filePath: string, contents: string): Promise<void> => {
  await fs.writeFile(filePath, contents, { mode: 0o755 });
};

afterEach(async () => {
  if (originalOpencodeBin === undefined) {
    delete process.env.FOREMAN_OPENCODE_BIN;
  } else {
    process.env.FOREMAN_OPENCODE_BIN = originalOpencodeBin;
  }

  if (originalClaudeBin === undefined) {
    delete process.env.FOREMAN_CLAUDE_BIN;
  } else {
    process.env.FOREMAN_CLAUDE_BIN = originalClaudeBin;
  }

  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("provider runners", () => {
  test.each([
    {
      label: "OpenCodeRunner",
      scriptName: "fake-opencode.js",
      setBin(scriptPath: string) {
        process.env.FOREMAN_OPENCODE_BIN = scriptPath;
      },
      createRunner() {
        return new OpenCodeRunner("openai/gpt-5.4", "high");
      },
    },
    {
      label: "ClaudeRunner",
      scriptName: "fake-claude.js",
      setBin(scriptPath: string) {
        process.env.FOREMAN_CLAUDE_BIN = scriptPath;
      },
      createRunner() {
        return new ClaudeRunner("claude-opus-4-6", "high");
      },
    },
  ])("escalates to SIGKILL when $label ignores SIGTERM", async ({ scriptName, setBin, createRunner }) => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, scriptName);
    await writeExecutableScript(
      scriptPath,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { setInterval(() => {}, 1000); });\n",
    );
    setBin(scriptPath);

    const abortController = new AbortController();
    const runner = createRunner();
    const runPromise = runner.invoke({
      attemptId: "attempt-1",
      action: "execution",
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

  test.each([
    {
      label: "OpenCodeRunner",
      scriptName: "fake-opencode.js",
      setBin(scriptPath: string) {
        process.env.FOREMAN_OPENCODE_BIN = scriptPath;
      },
      createRunner() {
        return new OpenCodeRunner("openai/gpt-5.4", "high");
      },
    },
    {
      label: "ClaudeRunner",
      scriptName: "fake-claude.js",
      setBin(scriptPath: string) {
        process.env.FOREMAN_CLAUDE_BIN = scriptPath;
      },
      createRunner() {
        return new ClaudeRunner("claude-opus-4-6", "high");
      },
    },
  ])("kills descendant processes that keep stdio open after abort for $label", async ({ scriptName, setBin, createRunner }) => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, scriptName);
    await writeExecutableScript(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', \"setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'inherit', 'inherit'] });",
        "process.stdin.resume();",
        "process.stdin.on('end', () => { setInterval(() => {}, 1000); });",
        "process.on('SIGTERM', () => { process.exit(0); });",
      ].join("\n"),
    );
    setBin(scriptPath);

    const abortController = new AbortController();
    const runner = createRunner();
    const startedAt = Date.now();
    const runPromise = runner.invoke({
      attemptId: "attempt-2",
      action: "execution",
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
    expect(result.signal).not.toBe("SIGKILL");
    expect(result.exitCode === 0 || result.exitCode === null).toBe(true);
  }, 10_000);

  test("selects the configured provider per action", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const opencodeScriptPath = path.join(tempDir, "fake-opencode.js");
    const claudeScriptPath = path.join(tempDir, "fake-claude.js");
    const captureScript = (provider: string) =>
      [
        "#!/usr/bin/env node",
        "let stdin = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { stdin += chunk; });",
        `process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ provider: '${provider}', argv: process.argv.slice(2), stdin })); });`,
      ].join("\n");

    await writeExecutableScript(opencodeScriptPath, captureScript("opencode"));
    await writeExecutableScript(claudeScriptPath, captureScript("claude"));
    process.env.FOREMAN_OPENCODE_BIN = opencodeScriptPath;
    process.env.FOREMAN_CLAUDE_BIN = claudeScriptPath;

    const config = createDefaultWorkspaceConfig("foo", "file");
    const executionRunner = createAgentRunner({ config, action: "execution" });
    const reviewRunner = createAgentRunner({ config, action: "review" });
    const reviewerRunner = createAgentRunner({ config, action: "reviewer" });
    const executionResult = await executionRunner.invoke({
      attemptId: "attempt-execution",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "execution prompt",
      timeoutMs: 5_000,
    });
    const reviewResult = await reviewRunner.invoke({
      attemptId: "attempt-review",
      action: "review",
      cwd: tempDir,
      env: {},
      prompt: "review prompt",
      timeoutMs: 5_000,
    });
    const reviewerResult = await reviewerRunner.invoke({
      attemptId: "attempt-reviewer",
      action: "reviewer",
      cwd: tempDir,
      env: {},
      prompt: "reviewer prompt",
      timeoutMs: 5_000,
    });

    expect(JSON.parse(executionResult.stdout)).toEqual({
      provider: "opencode",
      argv: ["run", "--model", "openai/gpt-5.4", "--variant", "high"],
      stdin: "execution prompt",
    });
    expect(JSON.parse(reviewResult.stdout)).toEqual({
      provider: "claude",
      argv: ["-p", "--dangerously-skip-permissions", "--model", "claude-opus-4-6", "--effort", "high"],
      stdin: "review prompt",
    });
    expect(JSON.parse(reviewerResult.stdout)).toEqual({
      provider: "claude",
      argv: ["-p", "--dangerously-skip-permissions", "--model", "claude-opus-4-6", "--effort", "high"],
      stdin: "reviewer prompt",
    });
  });
});
