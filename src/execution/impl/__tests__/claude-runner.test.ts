import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { ClaudeRunner } from "../claude-runner.js";
import { createTempDir } from "../../../test-support/helpers.js";

const cleanupDirs: string[] = [];
const originalClaudeBin = process.env.FOREMAN_CLAUDE_BIN;

const writeExecutableScript = async (filePath: string, contents: string): Promise<void> => {
  await fs.writeFile(filePath, contents, { mode: 0o755 });
};

afterEach(async () => {
  if (originalClaudeBin === undefined) {
    delete process.env.FOREMAN_CLAUDE_BIN;
  } else {
    process.env.FOREMAN_CLAUDE_BIN = originalClaudeBin;
  }

  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// Fake claude binary that echoes its argv and stdin back through `result.result`
// so the test can assert on what the runner actually spawned. session_id mirrors
// the --session-id / --resume value from argv so the runner round-trips a
// matching native session id back to the caller.
const echoArgvScript = [
  "#!/usr/bin/env node",
  "let stdin = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { stdin += chunk; });",
  "process.stdin.on('end', () => {",
  "  const argv = process.argv.slice(2);",
  "  const sessionIdIdx = Math.max(argv.indexOf('--session-id'), argv.indexOf('--resume'));",
  "  const sessionId = sessionIdIdx >= 0 ? argv[sessionIdIdx + 1] : '';",
  "  process.stdout.write(JSON.stringify({",
  "    type: 'result',",
  "    result: JSON.stringify({ argv, stdin }),",
  "    session_id: sessionId,",
  "  }) + '\\n');",
  "});",
].join("\n");

const setUpFakeClaude = async (): Promise<string> => {
  const tempDir = await createTempDir("foreman-runner-test-");
  cleanupDirs.push(tempDir);
  const claudeScriptPath = path.join(tempDir, "fake-claude.js");
  await writeExecutableScript(claudeScriptPath, echoArgvScript);
  process.env.FOREMAN_CLAUDE_BIN = claudeScriptPath;
  return tempDir;
};

describe("ClaudeRunner", () => {
  test("spawns claude with --exclude-dynamic-system-prompt-sections for fresh sessions", async () => {
    const tempDir = await setUpFakeClaude();

    const runner = new ClaudeRunner("opus-4.7", "high");
    const result = await runner.invoke({
      attemptId: "attempt-claude-fresh",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "fresh prompt",
      timeoutMs: 5_000,
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    const sessionIdIdx = invocation.argv.indexOf("--session-id");
    expect(sessionIdIdx).toBeGreaterThanOrEqual(0);
    // randomUUID produced the session id for fresh runs, so we extract and
    // assert on shape rather than a fixed value.
    const generatedSessionId = invocation.argv[sessionIdIdx + 1] ?? "";
    expect(generatedSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    expect(invocation.argv).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--exclude-dynamic-system-prompt-sections",
      "--model",
      "opus-4.7",
      "--effort",
      "high",
      "--output-format",
      "json",
      "--session-id",
      generatedSessionId,
    ]);
    expect(invocation.stdin).toBe("fresh prompt");
    expect(result.nativeSessionId).toBe(generatedSessionId);
  });

  test("spawns claude with --exclude-dynamic-system-prompt-sections for resumed sessions", async () => {
    const tempDir = await setUpFakeClaude();

    const runner = new ClaudeRunner("opus-4.7", "high");
    const resumedSessionId = "abcd1234-1111-2222-3333-444455556666";
    const result = await runner.invoke({
      attemptId: "attempt-claude-resume",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "resume prompt",
      timeoutMs: 5_000,
      nativeSessionId: resumedSessionId,
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    expect(invocation.argv).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--exclude-dynamic-system-prompt-sections",
      "--model",
      "opus-4.7",
      "--effort",
      "high",
      "--output-format",
      "json",
      "--resume",
      resumedSessionId,
    ]);
    expect(invocation.stdin).toBe("resume prompt");
    expect(result.nativeSessionId).toBe(resumedSessionId);
  });

  test("passes --max-budget-usd when maxBudgetUsd is configured", async () => {
    const tempDir = await setUpFakeClaude();

    const runner = new ClaudeRunner("claude-opus-4-7", "high", 100);
    const result = await runner.invoke({
      attemptId: "attempt-claude-budget",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "probe",
      timeoutMs: 5_000,
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    const flagIndex = invocation.argv.indexOf("--max-budget-usd");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(invocation.argv[flagIndex + 1]).toBe("100");
    expect(invocation.stdin).toBe("probe");
  });

  test("omits --max-budget-usd when maxBudgetUsd is not configured", async () => {
    const tempDir = await setUpFakeClaude();

    const runner = new ClaudeRunner("claude-opus-4-7", "high");
    const result = await runner.invoke({
      attemptId: "attempt-claude-no-budget",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "probe",
      timeoutMs: 5_000,
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    expect(invocation.argv).not.toContain("--max-budget-usd");
  });

  test("stringifies fractional maxBudgetUsd values for the CLI", async () => {
    const tempDir = await setUpFakeClaude();

    const runner = new ClaudeRunner("claude-opus-4-7", "high", 12.5);
    const result = await runner.invoke({
      attemptId: "attempt-claude-budget-fractional",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "probe",
      timeoutMs: 5_000,
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    const flagIndex = invocation.argv.indexOf("--max-budget-usd");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(invocation.argv[flagIndex + 1]).toBe("12.5");
  });
});
