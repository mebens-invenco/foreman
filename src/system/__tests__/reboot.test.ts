import { describe, expect, test } from "vitest";

import { runRebootUpdate, type CommandResult, type CommandRunner } from "../reboot.js";

const result = (stdout = "", exitCode = 0, stderr = ""): CommandResult => ({ exitCode, stdout, stderr });

const commandKey = (command: string, args: string[]): string => [command, ...args].join(" ");

const createCommandRunner = (responses: Record<string, CommandResult[]>) => {
  const calls: string[] = [];
  const runCommand: CommandRunner = async (command, args) => {
    const key = commandKey(command, args);
    calls.push(key);
    const response = responses[key]?.shift();
    if (!response) {
      throw new Error(`unexpected command: ${key}`);
    }

    return response;
  };

  return { calls, runCommand };
};

describe("runRebootUpdate", () => {
  test("skips git pull outside master", async () => {
    const logs: string[] = [];
    const { calls, runCommand } = createCommandRunner({
      "git rev-parse --abbrev-ref HEAD": [result("feature\n")],
    });

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: (message) => logs.push(message) });

    expect(outcome).toMatchObject({ branch: "feature", pullAttempted: false, installAttempted: false, buildAttempted: false });
    expect(calls).toEqual(["git rev-parse --abbrev-ref HEAD"]);
    expect(logs).toEqual(["skipping git pull because current branch is feature"]);
  });

  test("skips git pull for a dirty master worktree", async () => {
    const logs: string[] = [];
    const { calls, runCommand } = createCommandRunner({
      "git rev-parse --abbrev-ref HEAD": [result("master\n")],
      "git status --porcelain": [result(" M src/http.ts\n")],
    });

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: (message) => logs.push(message) });

    expect(outcome).toMatchObject({ branch: "master", dirty: true, pullAttempted: false });
    expect(calls).toEqual(["git rev-parse --abbrev-ref HEAD", "git status --porcelain"]);
    expect(logs).toEqual(["skipping git pull because the Foreman worktree has uncommitted changes"]);
  });

  test("logs pull failures without attempting install or build", async () => {
    const logs: string[] = [];
    const { calls, runCommand } = createCommandRunner({
      "git rev-parse --abbrev-ref HEAD": [result("master\n")],
      "git status --porcelain": [result()],
      "git rev-parse HEAD": [result("before\n")],
      "git pull --ff-only origin master": [result("", 1, "fatal: pull failed")],
    });

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: (message) => logs.push(message) });

    expect(outcome).toMatchObject({ pullAttempted: true, pulled: false, installAttempted: false, buildAttempted: false });
    expect(calls).not.toContain("yarn install");
    expect(calls).not.toContain("yarn build");
    expect(logs).toEqual(["git pull --ff-only origin master failed: fatal: pull failed"]);
  });

  test("does not install or build after a no-op pull", async () => {
    const logs: string[] = [];
    const { calls, runCommand } = createCommandRunner({
      "git rev-parse --abbrev-ref HEAD": [result("master\n")],
      "git status --porcelain": [result()],
      "git rev-parse HEAD": [result("same\n"), result("same\n")],
      "git pull --ff-only origin master": [result("Already up to date.\n")],
    });

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: (message) => logs.push(message) });

    expect(outcome).toMatchObject({ pulled: true, headChanged: false, installAttempted: false, buildAttempted: false });
    expect(calls).not.toContain("yarn install");
    expect(calls).not.toContain("yarn build");
    expect(logs).toEqual(["git pull completed without changing HEAD"]);
  });

  test("attempts install and build when pull changes HEAD and logs failures", async () => {
    const logs: string[] = [];
    const { calls, runCommand } = createCommandRunner({
      "git rev-parse --abbrev-ref HEAD": [result("master\n")],
      "git status --porcelain": [result()],
      "git rev-parse HEAD": [result("before\n"), result("after\n")],
      "git pull --ff-only origin master": [result("Updating before..after\n")],
      "yarn install": [result("", 1, "install failed")],
      "yarn build": [result("", 1, "build failed")],
    });

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: (message) => logs.push(message) });

    expect(outcome).toMatchObject({ pulled: true, headChanged: true, installAttempted: true, buildAttempted: true });
    expect(calls.slice(-2)).toEqual(["yarn install", "yarn build"]);
    expect(logs).toEqual(["yarn install failed: install failed", "yarn build failed: build failed"]);
  });
});
