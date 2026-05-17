import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, promises as fs } from "node:fs";
import path from "node:path";

import type { LoggerLevelName } from "../logger.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

export type RebootScheduleState = {
  status: "scheduled";
};

export type RebootScheduler = {
  scheduleReboot(): RebootScheduleState;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[], options: { cwd: string; timeoutMs?: number }) => Promise<CommandResult>;

type RebootLog = (message: string) => Promise<void> | void;

const scheduledState: RebootScheduleState = { status: "scheduled" };
const rebootCommandTimeoutMs = 5 * 60 * 1_000;

const rebootLogPath = (paths: WorkspacePaths): string => path.join(paths.logsDir, "reboot.log");

const formatLogLine = (message: string): string => `${new Date().toISOString()} ${message}\n`;

const appendRebootLog = async (paths: WorkspacePaths, message: string): Promise<void> => {
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.appendFile(rebootLogPath(paths), formatLogLine(message), "utf8");
};

const appendRebootLogSync = (paths: WorkspacePaths, message: string): void => {
  mkdirSync(paths.logsDir, { recursive: true });
  const logPath = rebootLogPath(paths);
  appendLogFileSync(logPath, message);
};

const appendLogFileSync = (logPath: string, message: string): void => {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    appendFileSync(fd, formatLogLine(message), "utf8");
  } finally {
    closeSync(fd);
  }
};

const runProcessCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      const suffix = `${command} ${args.join(" ")} timed out after ${options.timeoutMs ?? rebootCommandTimeoutMs}ms`;
      resolve({ exitCode: 124, stdout, stderr: stderr ? `${stderr}\n${suffix}` : suffix });
    }, options.timeoutMs ?? rebootCommandTimeoutMs);
    timeout.unref();

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ exitCode: 1, stdout, stderr: stderr ? `${stderr}\n${error.message}` : error.message }));
    child.on("close", (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
  });

const logCommandFailure = async (log: RebootLog, command: string, result: CommandResult): Promise<void> => {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  await log(`${command} failed: ${detail}`);
};

export type RebootUpdateOutcome = {
  branch: string | null;
  dirty: boolean;
  pullAttempted: boolean;
  pulled: boolean;
  headChanged: boolean;
  installAttempted: boolean;
  buildAttempted: boolean;
};

export const runRebootUpdate = async (input: {
  projectRoot: string;
  runCommand?: CommandRunner;
  log?: RebootLog;
  commandTimeoutMs?: number;
}): Promise<RebootUpdateOutcome> => {
  const runCommand = input.runCommand ?? runProcessCommand;
  const log = input.log ?? (() => undefined);
  const commandOptions = { cwd: input.projectRoot, timeoutMs: input.commandTimeoutMs ?? rebootCommandTimeoutMs };
  const outcome: RebootUpdateOutcome = {
    branch: null,
    dirty: false,
    pullAttempted: false,
    pulled: false,
    headChanged: false,
    installAttempted: false,
    buildAttempted: false,
  };

  const branch = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], commandOptions);
  if (branch.exitCode !== 0) {
    await logCommandFailure(log, "git rev-parse --abbrev-ref HEAD", branch);
    return outcome;
  }

  outcome.branch = branch.stdout.trim();
  if (outcome.branch !== "master") {
    await log(`skipping git pull because current branch is ${outcome.branch}`);
    return outcome;
  }

  const status = await runCommand("git", ["status", "--porcelain"], commandOptions);
  if (status.exitCode !== 0) {
    await logCommandFailure(log, "git status --porcelain", status);
    return outcome;
  }

  outcome.dirty = status.stdout.trim().length > 0;
  if (outcome.dirty) {
    await log("skipping git pull because the Foreman worktree has uncommitted changes");
    return outcome;
  }

  const beforeHead = await runCommand("git", ["rev-parse", "HEAD"], commandOptions);
  if (beforeHead.exitCode !== 0) {
    await logCommandFailure(log, "git rev-parse HEAD", beforeHead);
    return outcome;
  }

  outcome.pullAttempted = true;
  const pull = await runCommand("git", ["pull", "--ff-only", "origin", "master"], commandOptions);
  if (pull.exitCode !== 0) {
    await logCommandFailure(log, "git pull --ff-only origin master", pull);
    return outcome;
  }
  outcome.pulled = true;

  const afterHead = await runCommand("git", ["rev-parse", "HEAD"], commandOptions);
  if (afterHead.exitCode !== 0) {
    await logCommandFailure(log, "git rev-parse HEAD", afterHead);
    return outcome;
  }

  outcome.headChanged = beforeHead.stdout.trim() !== afterHead.stdout.trim();
  if (!outcome.headChanged) {
    await log("git pull completed without changing HEAD");
    return outcome;
  }

  outcome.installAttempted = true;
  const install = await runCommand("yarn", ["install"], commandOptions);
  if (install.exitCode !== 0) {
    await logCommandFailure(log, "yarn install", install);
  }

  outcome.buildAttempted = true;
  const build = await runCommand("yarn", ["build"], commandOptions);
  if (build.exitCode !== 0) {
    await logCommandFailure(log, "yarn build", build);
  }

  return outcome;
};

const waitForParentExit = async (parentPid: number, log: RebootLog): Promise<void> => {
  await log(`waiting for parent process ${parentPid} to exit`);
  while (true) {
    try {
      process.kill(parentPid, 0);
    } catch {
      await log("parent process has exited");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const waitForHttpUnavailable = async (host: string, port: number, log: RebootLog): Promise<void> => {
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${probeHost}:${port}/api/status`;
  await log(`waiting for ${url} to stop serving`);
  while (true) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1_000) });
    } catch {
      await log("http server is no longer serving");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

type DetachedSpawner = (command: string, args: string[], cwd: string, logPath: string) => boolean;

const spawnDetached: DetachedSpawner = (command, args, cwd, logPath) => {
  mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.on("error", (error) => appendLogFileSync(logPath, `failed to spawn ${command}: ${error.message}`));
    if (child.pid === undefined) {
      appendLogFileSync(logPath, `failed to spawn ${command}: child pid was not assigned`);
      return false;
    }

    child.unref();
    return true;
  } finally {
    closeSync(fd);
  }
};

export const runRebootSidecar = async (input: {
  paths: WorkspacePaths;
  workspace: string;
  logLevel: LoggerLevelName;
  host: string;
  port: number;
  parentPid: number;
  entrypointPath: string;
  runCommand?: CommandRunner;
  restart?: DetachedSpawner;
}): Promise<void> => {
  const log = (message: string): Promise<void> => appendRebootLog(input.paths, message);
  await log("reboot sidecar started");
  await waitForParentExit(input.parentPid, log);
  await waitForHttpUnavailable(input.host, input.port, log);
  await runRebootUpdate({ projectRoot: input.paths.projectRoot, runCommand: input.runCommand, log });
  await log("restarting foreman service");
  const args = [input.entrypointPath, "serve", input.workspace, "--log-level", input.logLevel];
  const restarted = (input.restart ?? spawnDetached)(process.execPath, args, input.paths.projectRoot, rebootLogPath(input.paths));
  if (!restarted) {
    await log("failed to restart foreman service");
  }
};

export const createSelfRebootScheduler = (input: {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  workspace: string;
  logLevel: LoggerLevelName;
  entrypointPath: string;
  spawnSidecar?: DetachedSpawner;
  signalShutdown?: () => void;
  setTimeout?: typeof setTimeout;
}): RebootScheduler => {
  let scheduled = false;
  const timer = input.setTimeout ?? setTimeout;
  const signalShutdown = input.signalShutdown ?? (() => process.kill(process.pid, "SIGTERM"));
  const spawnSidecar = input.spawnSidecar ?? spawnDetached;

  return {
    scheduleReboot(): RebootScheduleState {
      if (scheduled) {
        return scheduledState;
      }

      scheduled = true;
      appendRebootLogSync(input.paths, "reboot scheduled");
      const args = [
        input.entrypointPath,
        "reboot-sidecar",
        "--workspace",
        input.workspace,
        "--log-level",
        input.logLevel,
        "--host",
        input.config.http.host,
        "--port",
        String(input.config.http.port),
        "--parent-pid",
        String(process.pid),
        "--entrypoint",
        input.entrypointPath,
      ];
      let sidecarStarted = false;
      try {
        sidecarStarted = spawnSidecar(process.execPath, args, input.paths.projectRoot, rebootLogPath(input.paths));
      } catch (error) {
        scheduled = false;
        appendRebootLogSync(input.paths, `failed to spawn reboot sidecar: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }

      if (!sidecarStarted) {
        scheduled = false;
        throw new Error("Failed to spawn reboot sidecar.");
      }

      const handle = timer(() => signalShutdown(), 100);
      handle.unref();
      return scheduledState;
    },
  };
};
