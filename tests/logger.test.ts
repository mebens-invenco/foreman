import { PassThrough } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { WorkspacePaths } from "../src/config.js";
import { LoggerService } from "../src/logger.js";

const workspacePaths = (workspaceRoot: string): WorkspacePaths => ({
  projectRoot: workspaceRoot,
  workspaceRoot,
  configPath: path.join(workspaceRoot, "foreman.workspace.yml"),
  envPath: path.join(workspaceRoot, ".env"),
  dbPath: path.join(workspaceRoot, "foreman.db"),
  logsDir: path.join(workspaceRoot, "logs"),
  attemptsLogDir: path.join(workspaceRoot, "logs", "attempts"),
  artifactsDir: path.join(workspaceRoot, "artifacts"),
  worktreesDir: path.join(workspaceRoot, "worktrees"),
  tasksDir: path.join(workspaceRoot, "tasks"),
  planPath: path.join(workspaceRoot, "plan.md"),
});

describe("LoggerService", () => {
  test("keeps the file renderer unchanged and uses readable plain stdout when color is disabled", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "foreman-logger-"));
    const stdout = new PassThrough();
    let captured = "";
    stdout.on("data", (chunk) => {
      captured += String(chunk);
    });

    const logger = LoggerService.create({
      paths: workspacePaths(workspaceRoot),
      stdout,
      context: { workspace: "test-workspace" },
      colorMode: "never",
    });

    logger.info("logger initialized", { component: "test" });
    await logger.flush();

    const workspaceLog = await readFile(path.join(workspaceRoot, "logs", "foreman.log"), "utf8");
    expect(workspaceLog).toContain("INFO");
    expect(workspaceLog).toContain('workspace="test-workspace"');
    expect(workspaceLog).toContain('component="test"');
    expect(workspaceLog).toContain('message="logger initialized"');
    expect(captured).toContain("INFO");
    expect(captured).toContain("test logger initialized");
    expect(captured).toContain('workspace="test-workspace"');
    expect(captured).not.toContain("component=");
    expect(captured).not.toContain("message=");
  });

  test("child logger appends to the attempt log when attemptId is present", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "foreman-logger-attempt-"));
    const stdout = new PassThrough();
    stdout.resume();

    const logger = LoggerService.create({
      paths: workspacePaths(workspaceRoot),
      stdout,
      context: { workspace: "test-workspace" },
      colorMode: "never",
    });

    const attemptLogger = logger.child({ component: "scheduler", attemptId: "attempt-123", workerId: "worker-1" });
    attemptLogger.info("worker state changed", { jobId: "job-1" });
    await logger.flush();

    const attemptLog = await readFile(path.join(workspaceRoot, "logs", "attempts", "attempt-123.log"), "utf8");
    expect(attemptLog).toContain('attemptId="attempt-123"');
    expect(attemptLog).toContain('workerId="worker-1"');
    expect(attemptLog).toContain('jobId="job-1"');
    expect(attemptLog).toContain('message="worker state changed"');
  });

  test("writes raw runner output to the attempt log and only shows a worker badge in stdout", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "foreman-runner-line-"));
    const stdout = new PassThrough();
    let captured = "";
    stdout.on("data", (chunk) => {
      captured += String(chunk);
    });

    const logger = LoggerService.create({
      paths: workspacePaths(workspaceRoot),
      stdout,
      context: { workspace: "test-workspace" },
      colorMode: "never",
      minLevel: "error",
    });

    const attemptLogger = logger.child({ component: "scheduler", attemptId: "attempt-456", workerId: "worker-2" });
    attemptLogger.runnerLine("runner output line");
    await logger.flush();

    const attemptLog = await readFile(path.join(workspaceRoot, "logs", "attempts", "attempt-456.log"), "utf8");
    const workspaceLogPath = path.join(workspaceRoot, "logs", "foreman.log");
    expect(attemptLog).toBe("runner output line\n");
    expect(captured).toBe("[worker-2] runner output line\n");
    await expect(readFile(workspaceLogPath, "utf8")).rejects.toThrow();
  });

  test("uses ANSI styling for stdout when color is enabled", async () => {
    const stdout = new PassThrough();
    let captured = "";
    stdout.on("data", (chunk) => {
      captured += String(chunk);
    });

    const logger = LoggerService.create({
      stdout,
      context: { component: "root", workspace: "demo" },
      colorMode: "always",
    });

    logger.warn("something happened", { taskId: "TASK-1" });
    await logger.flush();

    expect(captured).toContain("\u001B[43m");
    expect(captured).toContain("\u001B[30m");
    expect(captured).toContain("\u001B[1mroot\u001B[0m");
    expect(captured).toContain("something happened");
    expect(captured).toContain("\u001B[90m\u001B[3mtaskId=\u001B[0m");
    expect(captured).toContain('"TASK-1"');
  });

  test("filters logs below the configured minimum level", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "foreman-logger-level-"));
    const stdout = new PassThrough();
    let captured = "";
    stdout.on("data", (chunk) => {
      captured += String(chunk);
    });

    const logger = LoggerService.create({
      paths: workspacePaths(workspaceRoot),
      stdout,
      context: { component: "test", workspace: "demo" },
      colorMode: "never",
      minLevel: "warn",
    });

    logger.info("hidden info");
    logger.warn("visible warn");
    await logger.flush();

    const workspaceLog = await readFile(path.join(workspaceRoot, "logs", "foreman.log"), "utf8");
    expect(captured).not.toContain("hidden info");
    expect(captured).toContain("visible warn");
    expect(workspaceLog).not.toContain("hidden info");
    expect(workspaceLog).toContain("visible warn");
  });
});
