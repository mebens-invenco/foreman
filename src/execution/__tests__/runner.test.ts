import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { ClaudeRunner, OpenCodeRunner, createAgentRunner } from "../index.js";
import { normalizeClaudeJsonOutput, normalizeCodexJsonOutput, normalizeOpenCodeJsonOutput } from "../impl/json-output.js";
import { runAgentProcess } from "../impl/run-agent-process.js";
import { extractClaudeUsage, extractCodexUsage, extractOpenCodeStepUsage, sumTokenUsage } from "../impl/token-usage.js";
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
        timeoutMs: 20,
      },
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.timeoutMs).toBe(20);
    expect(result.stdout).toBe("checkpoint\n");
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
      argv: ["run", "--model", "openai/gpt-5.4", "--variant", "high", "--format", "json"],
      stdin: "execution prompt",
    });
    expect(JSON.parse(reviewResult.stdout)).toEqual({
      provider: "opencode",
      argv: ["run", "--model", "openai/gpt-5.4", "--variant", "high", "--format", "json"],
      stdin: "review prompt",
    });
    const reviewerInvocation = JSON.parse(reviewerResult.stdout) as { provider: string; argv: string[]; stdin: string };
    expect(reviewerInvocation).toMatchObject({
      provider: "claude",
      stdin: "reviewer prompt",
    });
    expect(reviewerInvocation.argv.slice(0, 10)).toEqual([
      "-p",
      "--dangerously-skip-permissions",
      "--model",
      "claude-opus-4-6",
      "--effort",
      "high",
      "--output-format",
      "json",
      "--session-id",
      reviewerInvocation.argv[9],
    ]);
    expect(reviewerResult.nativeSessionId).toBe(reviewerInvocation.argv[9]);
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

  test("reports JSON normalization warnings and only extracts Claude result records", () => {
    expect(normalizeOpenCodeJsonOutput("{bad json")).toMatchObject({
      stdout: "{bad json",
      warning: expect.stringContaining("Failed to parse OpenCode JSON output"),
    });
    expect(normalizeClaudeJsonOutput("{bad json")).toMatchObject({
      stdout: "{bad json",
      warning: expect.stringContaining("Failed to parse Claude JSON output"),
    });

    const claudeOutput = [
      JSON.stringify({ type: "assistant", text: "intermediate" }),
      JSON.stringify({ type: "result", result: "final" }),
    ].join("\n");
    expect(normalizeClaudeJsonOutput(claudeOutput).stdout).toBe("final");

    const opencodeOutput = JSON.stringify({
      type: "text",
      sessionID: "opencode-session",
      part: {
        type: "text",
        text: '<agent-result>{"schemaVersion":1}</agent-result>',
      },
    });
    expect(normalizeOpenCodeJsonOutput(opencodeOutput)).toMatchObject({
      stdout: '<agent-result>{"schemaVersion":1}</agent-result>',
      nativeSessionId: "opencode-session",
    });

    const opencodeFinalAnswerOutput = [
      JSON.stringify({
        type: "text",
        part: {
          type: "text",
          text: "I will validate the required `<agent-result>` payload now.",
          metadata: { openai: { phase: "commentary" } },
        },
      }),
      JSON.stringify({
        type: "text",
        part: {
          type: "text",
          text: '<agent-result>{"schemaVersion":1}</agent-result>',
          metadata: { openai: { phase: "final_answer" } },
        },
      }),
    ].join("\n");
    expect(normalizeOpenCodeJsonOutput(opencodeFinalAnswerOutput).stdout).toBe(
      '<agent-result>{"schemaVersion":1}</agent-result>',
    );

    const opencodeProviderErrorOutput = [
      JSON.stringify({ type: "text", text: "Implemented the change." }),
      JSON.stringify({ type: "error", message: "JSON parsing failed: expected value" }),
    ].join("\n");
    expect(normalizeOpenCodeJsonOutput(opencodeProviderErrorOutput)).toMatchObject({
      stdout: "Implemented the change.",
      warning: expect.stringContaining("OpenCode JSON output contained error record(s): JSON parsing failed"),
    });
  });

  test("extracts Claude token usage from the result event's usage object", () => {
    // Empirical fixture captured from `claude -p --output-format json --session-id ...`
    // (single fresh call). `input_tokens` is already NEW input only.
    const claudeOutput = JSON.stringify({
      type: "result",
      result: "one",
      session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_creation_input_tokens: 32460,
        cache_read_input_tokens: 24417,
      },
    });
    expect(normalizeClaudeJsonOutput(claudeOutput).tokensUsed).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      cacheCreationInputTokens: 32460,
      cacheReadInputTokens: 24417,
    });

    const claudeOutputNoUsage = JSON.stringify({ type: "result", result: "final" });
    expect(normalizeClaudeJsonOutput(claudeOutputNoUsage).tokensUsed).toBeUndefined();
  });

  test("extracts Codex token usage and normalizes input_tokens to subtract cached portion", () => {
    // Empirical fixture from `codex exec --json -s read-only "Reply with 'one'."`.
    // Codex's raw `input_tokens` is TOTAL input (includes cached); the extractor
    // subtracts `cached_input_tokens` so stored `inputTokens` matches the
    // "new only" semantics used by Claude/OpenCode.
    const codexOutput = [
      JSON.stringify({ type: "thread.started", thread_id: "019e05ee-8b70-7ff1-812b-ac29b94d03ec" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "one" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 20341,
          cached_input_tokens: 3456,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
    ].join("\n");

    const normalized = normalizeCodexJsonOutput(codexOutput);
    expect(normalized.tokensUsed).toEqual({
      inputTokens: 20341 - 3456,
      outputTokens: 5,
      cacheReadInputTokens: 3456,
      reasoningOutputTokens: 0,
    });
    expect(normalized.nativeSessionId).toBe("019e05ee-8b70-7ff1-812b-ac29b94d03ec");
    expect(normalized.stdout).toBe("one");
  });

  test("extracts OpenCode token usage from step_finish.part.tokens", () => {
    // Empirical fixture from `opencode run --format json "Reply with 'one'."`.
    const opencodeOutput = [
      JSON.stringify({
        type: "step_start",
        sessionID: "ses_1fa1181e0ffesZ25ctVlinDFgI",
        part: { type: "step-start" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_1fa1181e0ffesZ25ctVlinDFgI",
        part: {
          type: "text",
          text: "one",
          metadata: { openai: { phase: "final_answer" } },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1fa1181e0ffesZ25ctVlinDFgI",
        part: {
          type: "step-finish",
          reason: "stop",
          tokens: { total: 17074, input: 17052, output: 7, reasoning: 15, cache: { write: 0, read: 0 } },
          cost: 0,
        },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).tokensUsed).toEqual({
      inputTokens: 17052,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 15,
    });
  });

  test("sums OpenCode token usage across multiple step_finish events", () => {
    // Empirical fixture from a multi-step opencode run with a tool call. Each
    // step_finish carries its step's delta; summing is required to get the
    // per-invocation total.
    const opencodeOutput = [
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_multi",
        part: {
          type: "step-finish",
          tokens: { total: 17144, input: 17075, output: 69, reasoning: 0, cache: { write: 0, read: 0 } },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_multi",
        part: {
          type: "step-finish",
          tokens: { total: 17168, input: 264, output: 8, reasoning: 0, cache: { write: 0, read: 16896 } },
        },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).tokensUsed).toEqual({
      inputTokens: 17075 + 264,
      outputTokens: 69 + 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 16896,
      reasoningOutputTokens: 0,
    });
  });

  test("ignores OpenCode events that are not step_finish when extracting tokens", () => {
    const opencodeOutput = [
      JSON.stringify({
        type: "text",
        sessionID: "ses_x",
        part: { type: "text", text: "hi", tokens: { total: 9999, input: 9999, output: 9999, cache: { read: 0, write: 0 } } },
      }),
      JSON.stringify({ type: "step_start", sessionID: "ses_x", part: { type: "step-start" } }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).tokensUsed).toBeUndefined();
  });

  test("returns undefined when extractors see no usage fields", () => {
    expect(extractClaudeUsage({})).toBeUndefined();
    expect(extractCodexUsage({})).toBeUndefined();
    expect(extractOpenCodeStepUsage({})).toBeUndefined();
    expect(extractOpenCodeStepUsage({ part: {} })).toBeUndefined();
  });

  test("session-level sum matches per-call deltas across all three runners", () => {
    // Property-style: simulate three back-to-back invocations on the same
    // session. Empirical numbers from spec match these fixtures.
    const claudeCalls = [
      // C1 (fresh) — only input/output relevant for the property
      { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 56881, cache_read_input_tokens: 0 },
      { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 111, cache_read_input_tokens: 56881 },
      { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 110, cache_read_input_tokens: 56992 },
    ];
    const claudeTotal = claudeCalls
      .map(extractClaudeUsage)
      .reduce<ReturnType<typeof sumTokenUsage>>((totals, current) => sumTokenUsage(totals, current), undefined);
    expect(claudeTotal).toEqual({
      inputTokens: 15,
      outputTokens: 18,
      cacheCreationInputTokens: 56881 + 111 + 110,
      cacheReadInputTokens: 0 + 56881 + 56992,
    });

    const codexCalls = [
      { input_tokens: 20344, cached_input_tokens: 3456, output_tokens: 17, reasoning_output_tokens: 10 },
      { input_tokens: 40719, cached_input_tokens: 23296, output_tokens: 22, reasoning_output_tokens: 10 },
      { input_tokens: 61113, cached_input_tokens: 43648, output_tokens: 27, reasoning_output_tokens: 10 },
    ];
    const codexTotal = codexCalls
      .map(extractCodexUsage)
      .reduce<ReturnType<typeof sumTokenUsage>>((totals, current) => sumTokenUsage(totals, current), undefined);
    // After Codex normalization, summing inputTokens is meaningful — each call
    // contributes only its NEW input, not the rehashed cached prior context.
    expect(codexTotal).toEqual({
      inputTokens: (20344 - 3456) + (40719 - 23296) + (61113 - 43648),
      outputTokens: 17 + 22 + 27,
      cacheReadInputTokens: 3456 + 23296 + 43648,
      reasoningOutputTokens: 30,
    });

    const opencodeSteps = [
      {
        type: "step_finish",
        part: { tokens: { total: 17055, input: 17050, output: 5, cache: { read: 0, write: 0 } } },
      },
      {
        type: "step_finish",
        part: { tokens: { total: 17079, input: 5298, output: 5, cache: { read: 11776, write: 0 } } },
      },
      {
        type: "step_finish",
        part: { tokens: { total: 17089, input: 5308, output: 5, cache: { read: 11776, write: 0 } } },
      },
    ];
    const opencodeTotal = opencodeSteps
      .map(extractOpenCodeStepUsage)
      .reduce<ReturnType<typeof sumTokenUsage>>((totals, current) => sumTokenUsage(totals, current), undefined);
    expect(opencodeTotal).toEqual({
      inputTokens: 17050 + 5298 + 5308,
      outputTokens: 15,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 11776 + 11776,
    });
  });
});
