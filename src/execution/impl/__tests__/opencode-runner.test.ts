import { afterEach, describe, expect, test } from "vitest";

import { OpenCodeRunner } from "../opencode-runner.js";
import { createFakeRunnerBin } from "../../../test-support/helpers.js";

// Fake opencode binary that echoes its argv and stdin as a single JSON object
// carrying no assistant-text fields (`type`/`text`/`part`/phase). With nothing
// to extract, normalizeOpenCodeJsonOutput passes the raw stdout through
// unchanged, so the test can parse argv/stdin back out and assert on exactly
// what the runner spawned.
const echoArgvScript = [
  "#!/usr/bin/env node",
  "let stdin = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { stdin += chunk; });",
  "process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin })); });",
].join("\n");

const fakeOpencode = createFakeRunnerBin({
  envVar: "FOREMAN_OPENCODE_BIN",
  script: echoArgvScript,
  scriptName: "fake-opencode.js",
});
const setUpFakeOpencode = (): Promise<string> => fakeOpencode.setUp();

afterEach(fakeOpencode.cleanup);

describe("OpenCodeRunner", () => {
  // Regression pin for ENG-5447: foreman workers (and `foreman eval`) run
  // unattended with stdin closed. Without --dangerously-skip-permissions
  // opencode auto-rejects its `ask` permissions (e.g. external_directory) and
  // disposes the session before the model emits `<agent-result>`, so the flag
  // must be present on every invocation.
  test("spawns opencode with --dangerously-skip-permissions for fresh sessions", async () => {
    const tempDir = await setUpFakeOpencode();

    const runner = new OpenCodeRunner("openai/gpt-5.5", "high");
    const result = await runner.invoke({
      attemptId: "attempt-opencode-fresh",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "fresh prompt",
      timeoutMs: 5_000,
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    expect(invocation.argv).toEqual([
      "run",
      "--dangerously-skip-permissions",
      "--model",
      "openai/gpt-5.5",
      "--variant",
      "high",
      "--format",
      "json",
    ]);
    expect(invocation.stdin).toBe("fresh prompt");
  });

  test("spawns opencode with --dangerously-skip-permissions and --session for resumed sessions", async () => {
    const tempDir = await setUpFakeOpencode();

    const runner = new OpenCodeRunner("openai/gpt-5.5", "high");
    const result = await runner.invoke({
      attemptId: "attempt-opencode-resume",
      action: "execution",
      cwd: tempDir,
      env: {},
      prompt: "resume prompt",
      timeoutMs: 5_000,
      nativeSessionId: "ses_resume",
    });

    const invocation = JSON.parse(result.stdout) as { argv: string[]; stdin: string };
    expect(invocation.argv).toEqual([
      "run",
      "--dangerously-skip-permissions",
      "--model",
      "openai/gpt-5.5",
      "--variant",
      "high",
      "--format",
      "json",
      "--session",
      "ses_resume",
    ]);
    expect(invocation.stdin).toBe("resume prompt");
  });
});
