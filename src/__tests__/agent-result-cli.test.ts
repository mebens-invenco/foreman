import { spawn } from "node:child_process";

import { describe, expect, test } from "vitest";

import { validateWorkerResultForAction, workerResultExample } from "../execution/worker-result.js";
import { testProjectRoot } from "../test-support/helpers.js";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const projectRoot = testProjectRoot;

const validExecutionResult = workerResultExample;

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
  test("keeps the exported example valid against the worker result schema", () => {
    expect(validateWorkerResultForAction(workerResultExample, "execution")).toEqual(workerResultExample);
  });

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

  test("accepts structured task creation mutations", () => {
    const result = {
      ...validExecutionResult,
      taskMutations: [
        {
          type: "create_task",
          title: "Follow-up task",
          description: "Do the follow-up work.",
          repos: ["repo-a", "repo-b"],
          priority: "high",
          dependencies: { taskIds: ["ENG-123"], baseTaskId: "ENG-122" },
          repoDependencies: [{ taskTargetRepoKey: "repo-b", dependsOnRepoKey: "repo-a" }],
          branchName: "eng-124",
        },
      ],
    };

    expect(validateWorkerResultForAction(result, "execution").taskMutations).toEqual(result.taskMutations);
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
