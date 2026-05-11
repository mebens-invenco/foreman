import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { CodexRunner, isValidCodexThreadId } from "../codex-runner.js";
import { createTempDir } from "../../../test-support/helpers.js";

const cleanupDirs: string[] = [];
const originalCodexBin = process.env.FOREMAN_CODEX_BIN;

const writeExecutableScript = async (filePath: string, contents: string): Promise<void> => {
  await fs.writeFile(filePath, contents, { mode: 0o755 });
};

afterEach(async () => {
  if (originalCodexBin === undefined) {
    delete process.env.FOREMAN_CODEX_BIN;
  } else {
    process.env.FOREMAN_CODEX_BIN = originalCodexBin;
  }

  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const echoArgvScript = [
  "#!/usr/bin/env node",
  "let stdin = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { stdin += chunk; });",
  "process.stdin.on('end', () => {",
  "  const argv = process.argv.slice(2);",
  "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '019e05ee-8b70-7ff1-812b-ac29b94d03ec' }) + '\\n');",
  "  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');",
  "  process.stdout.write(JSON.stringify({",
  "    type: 'item.completed',",
  "    item: { id: 'item_0', type: 'agent_message', text: JSON.stringify({ argv, stdin }) },",
  "  }) + '\\n');",
  "  process.stdout.write(JSON.stringify({",
  "    type: 'turn.completed',",
  "    usage: { input_tokens: 20341, cached_input_tokens: 3456, output_tokens: 5, reasoning_output_tokens: 0 },",
  "  }) + '\\n');",
  "});",
].join("\n");

describe("CodexRunner", () => {
  test("passes the prompt over stdin and captures thread_id from thread.started events", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const codexScriptPath = path.join(tempDir, "fake-codex.js");
    // Mirror codex's `--json` JSONL output: thread.started, turn.started,
    // item.completed (agent_message), turn.completed (with usage). Echo the
    // command-line args and stdin so the test can assert on argv layout.
    await writeExecutableScript(codexScriptPath, echoArgvScript);
    process.env.FOREMAN_CODEX_BIN = codexScriptPath;

    const runner = new CodexRunner("gpt-5.5", "high");
    const freshResult = await runner.invoke({
      attemptId: "attempt-codex-fresh",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "fresh prompt",
      timeoutMs: 5_000,
    });

    const freshInvocation = JSON.parse(freshResult.stdout) as { argv: string[]; stdin: string };
    expect(freshInvocation.argv).toEqual([
      "exec",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
    expect(freshInvocation.stdin).toBe("fresh prompt");
    expect(freshResult.nativeSessionId).toBe("019e05ee-8b70-7ff1-812b-ac29b94d03ec");
    expect(freshResult.tokensUsed).toEqual({
      inputTokens: 20341 - 3456,
      outputTokens: 5,
      cacheReadInputTokens: 3456,
      reasoningOutputTokens: 0,
    });

    const resumeResult = await runner.invoke({
      attemptId: "attempt-codex-resume",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "resume prompt",
      timeoutMs: 5_000,
      nativeSessionId: "019e05ee-8b70-7ff1-812b-ac29b94d03ec",
    });

    const resumeInvocation = JSON.parse(resumeResult.stdout) as { argv: string[]; stdin: string };
    expect(resumeInvocation.argv).toEqual([
      "exec",
      "resume",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_reasoning_effort="high"',
      "--",
      "019e05ee-8b70-7ff1-812b-ac29b94d03ec",
      "-",
    ]);
    expect(resumeInvocation.stdin).toBe("resume prompt");
    // Codex's thread.started fixture echoes the resumed thread id, so we expect
    // the runner to surface that same id back to the caller.
    expect(resumeResult.nativeSessionId).toBe("019e05ee-8b70-7ff1-812b-ac29b94d03ec");
  });

  test("TOML-escapes model and effort values via JSON.stringify so quotes and newlines do not break the -c payload", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const codexScriptPath = path.join(tempDir, "fake-codex.js");
    await writeExecutableScript(codexScriptPath, echoArgvScript);
    process.env.FOREMAN_CODEX_BIN = codexScriptPath;

    // Adversarial inputs: model contains a quote (TOML basic-string delimiter)
    // and effort contains a newline (TOML basic-strings forbid raw newlines).
    // JSON.stringify escapes both correctly, producing a valid TOML basic string.
    const runner = new CodexRunner('evil"model', "high\nbreak");
    const result = await runner.invoke({
      attemptId: "attempt-codex-escape",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "probe",
      timeoutMs: 5_000,
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    // JSON.stringify('evil"model') === '"evil\\"model"' and
    // JSON.stringify('high\nbreak') === '"high\\nbreak"' — both valid TOML
    // basic strings that round-trip back to the original values when parsed.
    expect(invocation.argv).toContain('model="evil\\"model"');
    expect(invocation.argv).toContain('model_reasoning_effort="high\\nbreak"');
  });

  test("rejects option-shaped and otherwise-malformed nativeSessionId values", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const codexScriptPath = path.join(tempDir, "fake-codex.js");
    await writeExecutableScript(codexScriptPath, echoArgvScript);
    process.env.FOREMAN_CODEX_BIN = codexScriptPath;

    const runner = new CodexRunner("gpt-5.5", "high");
    const baseRequest = {
      attemptId: "attempt-codex-bad-id",
      action: "execution" as const,
      cwd: tempDir,
      env: {},
      prompt: "probe",
      timeoutMs: 5_000,
    };

    // Empty string is treated as "no session" by `invoke()` (falsy guard) and
    // does not reach the validator; we only exercise non-empty malformed cases.
    for (const badId of ["--last", "-c foo=bar", " ", "not-a-uuid", "../../etc/passwd"]) {
      await expect(runner.invoke({ ...baseRequest, nativeSessionId: badId })).rejects.toThrow(
        /Invalid Codex thread id/,
      );
    }
  });
});

describe("isValidCodexThreadId", () => {
  test("accepts canonical 8-4-4-4-12 hex UUIDs", () => {
    expect(isValidCodexThreadId("019e05ee-8b70-7ff1-812b-ac29b94d03ec")).toBe(true);
    expect(isValidCodexThreadId("00000000-0000-0000-0000-000000000000")).toBe(true);
    // Case-insensitive — codex sometimes uppercases.
    expect(isValidCodexThreadId("019E05EE-8B70-7FF1-812B-AC29B94D03EC")).toBe(true);
  });

  test("rejects option-shaped, empty, whitespace, and otherwise-malformed values", () => {
    expect(isValidCodexThreadId("--last")).toBe(false);
    expect(isValidCodexThreadId("-c foo=bar")).toBe(false);
    expect(isValidCodexThreadId(" ")).toBe(false);
    expect(isValidCodexThreadId("")).toBe(false);
    expect(isValidCodexThreadId("codex-thread-fresh")).toBe(false);
    expect(isValidCodexThreadId("019e05ee-8b70-7ff1-812b-ac29b94d03e")).toBe(false); // too short
    expect(isValidCodexThreadId("019e05ee 8b70-7ff1-812b-ac29b94d03ec")).toBe(false); // space, not hyphen
    expect(isValidCodexThreadId(undefined)).toBe(false);
    expect(isValidCodexThreadId(null)).toBe(false);
    expect(isValidCodexThreadId(123)).toBe(false);
  });
});
