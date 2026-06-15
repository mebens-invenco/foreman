import path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { runRebootSidecar, runRebootUpdate, type CommandResult, type CommandRunner } from "../reboot.js";
import { createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";

const result = (stdout = "", exitCode = 0, stderr = ""): CommandResult => ({ exitCode, stdout, stderr });

const commandKey = (command: string, args: string[]): string => [command, ...args].join(" ");

const captureLog = (logs: string[]) => (message: string): void => {
  logs.push(message);
};

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

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: captureLog(logs) });

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

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: captureLog(logs) });

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

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: captureLog(logs) });

    expect(outcome).toMatchObject({ pullAttempted: true, pulled: false, installAttempted: false, buildAttempted: false });
    expect(calls).not.toContain("pnpm install --frozen-lockfile");
    expect(calls).not.toContain("pnpm run build");
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

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: captureLog(logs) });

    expect(outcome).toMatchObject({ pulled: true, headChanged: false, installAttempted: false, buildAttempted: false });
    expect(calls).not.toContain("pnpm install --frozen-lockfile");
    expect(calls).not.toContain("pnpm run build");
    expect(logs).toEqual(["git pull completed without changing HEAD"]);
  });

  test("attempts install and build when pull changes HEAD and logs failures", async () => {
    const logs: string[] = [];
    const { calls, runCommand } = createCommandRunner({
      "git rev-parse --abbrev-ref HEAD": [result("master\n")],
      "git status --porcelain": [result()],
      "git rev-parse HEAD": [result("before\n"), result("after\n")],
      "git pull --ff-only origin master": [result("Updating before..after\n")],
      "pnpm install --frozen-lockfile": [result("", 1, "install failed")],
      "pnpm run build": [result("", 1, "build failed")],
    });

    const outcome = await runRebootUpdate({ projectRoot: "/foreman", runCommand, log: captureLog(logs) });

    expect(outcome).toMatchObject({ pulled: true, headChanged: true, installAttempted: true, buildAttempted: true });
    expect(calls.slice(-2)).toEqual(["pnpm install --frozen-lockfile", "pnpm run build"]);
    expect(logs).toEqual([
      "pnpm install --frozen-lockfile failed: install failed",
      "pnpm run build failed: build failed",
    ]);
  });
});

describe("runRebootSidecar", () => {
  test("waits for parent and HTTP shutdown before updating and restarting Foreman", async () => {
    const workspaceRoot = await createTempDir("foreman-reboot-sidecar-test-");
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("server down"));
    const killMock = vi.spyOn(process, "kill").mockImplementation((() => {
      throw new Error("parent exited");
    }) as typeof process.kill);
    const restart = vi.fn(() => true);
    const { calls, runCommand } = createCommandRunner({
      "git rev-parse --abbrev-ref HEAD": [result("feature\n")],
    });

    try {
      await runRebootSidecar({
        paths,
        workspace: "foo",
        logLevel: "info",
        host: "0.0.0.0",
        port: 8765,
        parentPid: 1234,
        entrypointPath: "/foreman/dist/cli.js",
        runCommand,
        restart,
      });

      expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8765/api/status", { signal: expect.any(AbortSignal) });
      expect(calls).toEqual(["git rev-parse --abbrev-ref HEAD"]);
      expect(restart).toHaveBeenCalledWith(
        process.execPath,
        ["/foreman/dist/cli.js", "serve", "foo", "--log-level", "info"],
        paths.projectRoot,
        path.join(paths.logsDir, "reboot.log"),
      );

      const log = await fs.readFile(path.join(paths.logsDir, "reboot.log"), "utf8");
      expect(log).toContain("reboot sidecar started");
      expect(log).toContain("parent process has exited");
      expect(log).toContain("http server is no longer serving");
      expect(log).toContain("restarting foreman service");
    } finally {
      fetchMock.mockRestore();
      killMock.mockRestore();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
