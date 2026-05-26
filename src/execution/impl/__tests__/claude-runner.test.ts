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

// Mirror claude's JSON-mode output: a single JSON object with `session_id` and
// `result`. Echo argv inside `result` so the test can assert on the spawned
// flag layout.
const echoArgvScript = [
  "#!/usr/bin/env node",
  "let stdin = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { stdin += chunk; });",
  "process.stdin.on('end', () => {",
  "  const argv = process.argv.slice(2);",
  "  process.stdout.write(JSON.stringify({ session_id: 'claude-session', result: JSON.stringify({ argv, stdin }) }));",
  "});",
].join("\n");

const setUpFakeClaude = async (): Promise<string> => {
  const tempDir = await createTempDir("foreman-claude-runner-test-");
  cleanupDirs.push(tempDir);
  const claudeScriptPath = path.join(tempDir, "fake-claude.js");
  await writeExecutableScript(claudeScriptPath, echoArgvScript);
  process.env.FOREMAN_CLAUDE_BIN = claudeScriptPath;
  return tempDir;
};

describe("ClaudeRunner", () => {
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
    expect(invocation.argv).toContain("--max-budget-usd");
    const flagIndex = invocation.argv.indexOf("--max-budget-usd");
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
