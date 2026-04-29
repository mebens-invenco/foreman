import { spawn } from "node:child_process";

import { describe, expect, test } from "vitest";

import { testProjectRoot } from "../test-support/helpers.js";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const projectRoot = testProjectRoot;

const validExecutionResult = {
  schemaVersion: 1,
  action: "execution",
  outcome: "completed",
  summary: "Validated output.",
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [],
  blockers: [],
  signals: [],
};

const runCli = async (args: string[], input = ""): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: projectRoot });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });

describe("agent-result cli", () => {
  test("accepts valid raw JSON and wrapped agent result blocks", async () => {
    const raw = await runCli(["agent-result", "validate", "--action", "execution"], JSON.stringify(validExecutionResult));
    expect(raw.code).toBe(0);
    expect(raw.stdout).toContain('Agent result is valid for action "execution".');

    const wrapped = await runCli(
      ["agent-result", "validate", "--action", "execution"],
      `<agent-result>\n${JSON.stringify(validExecutionResult)}\n</agent-result>`,
    );
    expect(wrapped.code).toBe(0);
    expect(wrapped.stdout).toContain('Agent result is valid for action "execution".');
  });

  test("rejects invalid results with field-specific validation errors", async () => {
    const result = await runCli(["agent-result", "validate", "--action", "execution"], JSON.stringify({ schemaVersion: 1, action: "execution" }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Agent result is invalid for action "execution"');
    expect(result.stderr).toContain("- summary:");
    expect(result.stderr).toContain("- taskMutations:");
  });

  test("rejects output for a different action", async () => {
    const result = await runCli(["agent-result", "validate", "--action", "review"], JSON.stringify(validExecutionResult));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("- action:");
    expect(result.stderr).toContain("review");
  });

  test("documents the action-specific accepted shape in help", async () => {
    const result = await runCli(["agent-result", "validate", "--action", "reviewer", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Required action literal: "reviewer".');
    expect(result.stdout).toContain("Stdin may be either raw JSON or one complete <agent-result>...</agent-result> block");
    expect(result.stdout).toContain("generated from Foreman's Zod worker result schema");
    expect(result.stdout).toContain('"const": "reviewer"');
    expect(result.stdout).toContain('"const": "create_pull_request"');
    expect(result.stdout).toContain('"required"');
    expect(result.stdout).toContain("Minimal raw JSON example");
  });
});
