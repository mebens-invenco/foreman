import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { ClaudeRunner, CodexRunner, OpenCodeRunner, createAgentRunner } from "../index.js";
import { runAgentProcess } from "../impl/run-agent-process.js";
import { createTempDir } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";

const cleanupDirs: string[] = [];
const originalOpencodeBin = process.env.FOREMAN_OPENCODE_BIN;
const originalClaudeBin = process.env.FOREMAN_CLAUDE_BIN;
const originalCodexBin = process.env.FOREMAN_CODEX_BIN;

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

  if (originalCodexBin === undefined) {
    delete process.env.FOREMAN_CODEX_BIN;
  } else {
    process.env.FOREMAN_CODEX_BIN = originalCodexBin;
  }

  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("provider runners", () => {
  test("reports timeout metadata when the configured runner timeout terminates the process", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, "fake-runner.js");
    await writeExecutableScript(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "process.on('SIGTERM', () => { process.exit(0); });",
        "process.stdout.write('checkpoint\\n');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => { setInterval(() => {}, 1000); });",
      ].join("\n"),
    );

    const result = await runAgentProcess({
      command: scriptPath,
      args: [],
      request: {
        attemptId: "attempt-timeout",
        action: "execution",
        cwd: tempDir,
        env: {},
        prompt: "test prompt",
        timeoutMs: 200,
      },
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.timeoutMs).toBe(200);
    expect(result.stdout).toBe("checkpoint\n");
  }, 10_000);

  test("sets PWD to the requested cwd for spawned runners", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, "fake-runner.js");
    await writeExecutableScript(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD }));",
        "});",
      ].join("\n"),
    );

    const result = await runAgentProcess({
      command: scriptPath,
      args: [],
      request: {
        attemptId: "attempt-pwd",
        action: "execution",
        cwd: tempDir,
        env: { PWD: "/stale-parent" },
        prompt: "test prompt",
        timeoutMs: 5_000,
      },
    });

    expect(JSON.parse(result.stdout)).toEqual({ cwd: tempDir, pwd: tempDir });
  });

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
    {
      label: "CodexRunner",
      scriptName: "fake-codex.js",
      setBin(scriptPath: string) {
        process.env.FOREMAN_CODEX_BIN = scriptPath;
      },
      createRunner() {
        return new CodexRunner("gpt-5.5", "high");
      },
    },
  ])("escalates to SIGKILL when $label ignores SIGTERM", async ({ scriptName, setBin, createRunner }) => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, scriptName);
    await writeExecutableScript(
      scriptPath,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nprocess.stdout.write('ready\\n');\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { setInterval(() => {}, 1000); });\n",
    );
    setBin(scriptPath);

    const abortController = new AbortController();
    const runner = createRunner();
    let resolveReady: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const runPromise = runner.invoke({
      attemptId: "attempt-1",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "test prompt",
      timeoutMs: 60_000,
      abortSignal: abortController.signal,
      onStdoutLine(line) {
        if (line === "ready") {
          resolveReady?.();
          resolveReady = undefined;
        }
      },
    });

    await readyPromise;
    abortController.abort();

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
    {
      label: "CodexRunner",
      scriptName: "fake-codex.js",
      setBin(scriptPath: string) {
        process.env.FOREMAN_CODEX_BIN = scriptPath;
      },
      createRunner() {
        return new CodexRunner("gpt-5.5", "high");
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
      argv: ["run", "--model", "openai/gpt-5.5", "--variant", "high", "--format", "json"],
      stdin: "execution prompt",
    });
    expect(JSON.parse(reviewResult.stdout)).toEqual({
      provider: "opencode",
      argv: ["run", "--model", "openai/gpt-5.5", "--variant", "high", "--format", "json"],
      stdin: "review prompt",
    });
    const reviewerInvocation = JSON.parse(reviewerResult.stdout) as { provider: string; argv: string[]; stdin: string };
    expect(reviewerInvocation).toMatchObject({
      provider: "claude",
      stdin: "reviewer prompt",
    });
    expect(reviewerInvocation.argv.slice(0, 11)).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--exclude-dynamic-system-prompt-sections",
      "--model",
      "claude-opus-4-7",
      "--effort",
      "high",
      "--output-format",
      "json",
      "--session-id",
      reviewerInvocation.argv[10],
    ]);
    expect(reviewerResult.nativeSessionId).toBe(reviewerInvocation.argv[10]);
  });

  test("resumes native provider sessions and normalizes JSON-mode output", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const opencodeScriptPath = path.join(tempDir, "fake-opencode.js");
    await writeExecutableScript(
      opencodeScriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ sessionID: 'opencode-session', type: 'text', text: '<agent-result>' }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'text', text: '{\\\"schemaVersion\\\":1}' }) + '\\n');",
        "  process.stdout.write(JSON.stringify({ type: 'final', text: '<agent-result>{\\\"schemaVersion\\\":1}</agent-result>' }) + '\\n');",
        "});",
      ].join("\n"),
    );
    process.env.FOREMAN_OPENCODE_BIN = opencodeScriptPath;

    const opencodeResult = await new OpenCodeRunner("openai/gpt-5.4", "high").invoke({
      attemptId: "attempt-opencode-json",
      action: "review",
      cwd: tempDir,
      env: {},
      prompt: "continue",
      timeoutMs: 5_000,
      nativeSessionId: "opencode-session",
    });
    expect(opencodeResult.stdout).toBe('<agent-result>{"schemaVersion":1}</agent-result>');
    expect(opencodeResult.nativeSessionId).toBe("opencode-session");

    const claudeScriptPath = path.join(tempDir, "fake-claude.js");
    await writeExecutableScript(
      claudeScriptPath,
      [
        "#!/usr/bin/env node",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ session_id: 'claude-session', result: '<agent-result>{\\\"schemaVersion\\\":1}</agent-result>' }));",
        "});",
      ].join("\n"),
    );
    process.env.FOREMAN_CLAUDE_BIN = claudeScriptPath;

    const claudeResult = await new ClaudeRunner("claude-opus-4-6", "high").invoke({
      attemptId: "attempt-claude-json",
      action: "reviewer",
      cwd: tempDir,
      env: {},
      prompt: "continue",
      timeoutMs: 5_000,
      nativeSessionId: "claude-session",
    });
    expect(claudeResult.stdout).toBe('<agent-result>{"schemaVersion":1}</agent-result>');
    expect(claudeResult.nativeSessionId).toBe("claude-session");
  });

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
      script: [
        "#!/usr/bin/env node",
        "const argv = process.argv.slice(2);",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  if (argv.includes('--session')) { process.stderr.write('resume failed\\n'); process.exit(1); }",
        "  process.stdout.write(JSON.stringify({ sessionID: 'fresh-opencode-session', type: 'final', text: '<agent-result>{\\\"schemaVersion\\\":1}</agent-result>' }));",
        "});",
      ].join("\n"),
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
      script: [
        "#!/usr/bin/env node",
        "const argv = process.argv.slice(2);",
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  if (argv.includes('--resume')) { process.stderr.write('resume failed\\n'); process.exit(1); }",
        "  const sessionId = argv[argv.indexOf('--session-id') + 1];",
        "  process.stdout.write(JSON.stringify({ session_id: sessionId, type: 'result', result: '<agent-result>{\\\"schemaVersion\\\":1}</agent-result>' }));",
        "});",
      ].join("\n"),
    },
  ])("does not start a fresh native session when $label resume exits non-zero", async ({ scriptName, setBin, createRunner, script }) => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const scriptPath = path.join(tempDir, scriptName);
    await writeExecutableScript(scriptPath, script);
    setBin(scriptPath);

    const stderrLines: string[] = [];
    const result = await createRunner().invoke({
      attemptId: "attempt-resume-failure",
      action: "review",
      cwd: tempDir,
      env: {},
      prompt: "continue",
      timeoutMs: 5_000,
      nativeSessionId: "stale-session",
      onStderrLine(line) {
        stderrLines.push(line);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(stderrLines).toContain("resume failed");
    expect(stderrLines.some((line) => line.includes("starting a fresh session"))).toBe(false);
  });
});
