import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { CodexRunner } from "../codex-runner.js";
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

describe("CodexRunner", () => {
  test("passes the prompt over stdin and captures thread_id from thread.started events", async () => {
    const tempDir = await createTempDir("foreman-runner-test-");
    cleanupDirs.push(tempDir);

    const codexScriptPath = path.join(tempDir, "fake-codex.js");
    // Mirror codex's `--json` JSONL output: thread.started, turn.started,
    // item.completed (agent_message), turn.completed (with usage). Echo the
    // command-line args and stdin so the test can assert on argv layout.
    await writeExecutableScript(
      codexScriptPath,
      [
        "#!/usr/bin/env node",
        "let stdin = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { stdin += chunk; });",
        "process.stdin.on('end', () => {",
        "  const argv = process.argv.slice(2);",
        "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-fresh' }) + '\\n');",
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
      ].join("\n"),
    );
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
      'sandbox_permissions=["disk-full-write-access"]',
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
    expect(freshInvocation.stdin).toBe("fresh prompt");
    expect(freshResult.nativeSessionId).toBe("codex-thread-fresh");
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
      nativeSessionId: "codex-thread-fresh",
    });

    const resumeInvocation = JSON.parse(resumeResult.stdout) as { argv: string[]; stdin: string };
    expect(resumeInvocation.argv).toEqual([
      "exec",
      "resume",
      "--json",
      "-c",
      'sandbox_permissions=["disk-full-write-access"]',
      "-c",
      'model="gpt-5.5"',
      "-c",
      'model_reasoning_effort="high"',
      "codex-thread-fresh",
      "-",
    ]);
    expect(resumeInvocation.stdin).toBe("resume prompt");
    // Codex's thread.started fixture echoes the resumed thread id, so we expect
    // the runner to surface that same id back to the caller.
    expect(resumeResult.nativeSessionId).toBe("codex-thread-fresh");
  });
});
