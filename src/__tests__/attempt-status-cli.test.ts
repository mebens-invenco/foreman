import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { stringifyWorkspaceConfig, createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createMigratedDb, createWorkspacePaths, testProjectRoot } from "../test-support/helpers.js";
import type { ForemanRepos } from "../repos/index.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;
const workspacesRoot = path.join(projectRoot, "workspaces");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createCliWorkspace = async (): Promise<{ workspaceName: string; workspaceRoot: string; dbPath: string }> => {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(workspacesRoot, "foreman-status-cli-test-"));
  cleanupDirs.push(workspaceRoot);
  const workspaceName = path.basename(workspaceRoot);
  const paths = createWorkspacePaths(projectRoot, workspaceRoot);

  await fs.writeFile(paths.configPath, stringifyWorkspaceConfig(createDefaultWorkspaceConfig(workspaceName, "file")), "utf8");
  await fs.writeFile(paths.envPath, "", "utf8");

  return { workspaceName, workspaceRoot, dbPath: paths.dbPath };
};

const seedRunningAttempt = (db: ForemanRepos): { attemptId: string; workerId: string } => {
  db.workers.ensureWorkerSlots(1);
  const worker = db.workers.listWorkers()[0]!;
  const job = db.jobs.createCronJob({
    cronJobId: "cron/observability.md",
    dedupeKey: "cron:cron/observability.md",
    selectionReason: "test",
  });
  const attempt = db.attempts.createAttemptWithLeases({
    jobId: job.id,
    workerId: worker.id,
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    runnerVariant: "standard",
    expiresAt: "2026-03-16T00:10:00Z",
    leases: [{ resourceType: "cron", resourceKey: job.dedupeKey }],
  })!;
  db.workers.updateWorkerStatus(worker.id, "running", attempt.id);
  return { attemptId: attempt.id, workerId: worker.id };
};

const runCli = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
  return execFileAsync("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: projectRoot });
};

const parseJsonOutput = (stdout: string): unknown => JSON.parse(stdout);

describe("status cli", () => {
  test("--attempt prints deterministic snapshot", async () => {
    const { workspaceName, dbPath } = await createCliWorkspace();
    const db = await createMigratedDb(dbPath, projectRoot);
    let attemptId: string;
    try {
      ({ attemptId } = seedRunningAttempt(db));
      db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "assistant_message",
        message: "moving along",
      });
    } finally {
      db.close();
    }

    const { stdout } = await runCli(["status", workspaceName, "--attempt", attemptId]);
    const body = parseJsonOutput(stdout) as {
      workspace: string;
      attemptId: string;
      snapshot: { phase: string; counts: { activities: number }; needsHuman: { isNeeded: boolean } };
    };
    expect(body.workspace).toBe(workspaceName);
    expect(body.attemptId).toBe(attemptId);
    expect(body.snapshot.counts.activities).toBe(1);
    expect(body.snapshot.needsHuman.isNeeded).toBe(false);
  });

  test("--worker prints snapshot of current attempt", async () => {
    const { workspaceName, dbPath } = await createCliWorkspace();
    const db = await createMigratedDb(dbPath, projectRoot);
    let workerId: string;
    let attemptId: string;
    try {
      ({ workerId, attemptId } = seedRunningAttempt(db));
    } finally {
      db.close();
    }

    const { stdout } = await runCli(["status", workspaceName, "--worker", workerId]);
    const body = parseJsonOutput(stdout) as {
      worker: { id: string; currentAttemptId: string | null };
      snapshot: { attemptId: string } | null;
    };
    expect(body.worker.id).toBe(workerId);
    expect(body.worker.currentAttemptId).toBe(attemptId);
    expect(body.snapshot?.attemptId).toBe(attemptId);
  });

  test("requires exactly one of --attempt or --worker", async () => {
    const { workspaceName } = await createCliWorkspace();

    await expect(runCli(["status", workspaceName])).rejects.toThrow(/exactly one of --attempt or --worker/);
  });
});

describe("tail cli", () => {
  test("returns activity rows for the attempt", async () => {
    const { workspaceName, dbPath } = await createCliWorkspace();
    const db = await createMigratedDb(dbPath, projectRoot);
    let attemptId: string;
    try {
      ({ attemptId } = seedRunningAttempt(db));
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "one" });
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "two" });
    } finally {
      db.close();
    }

    const { stdout } = await runCli(["tail", workspaceName, "--attempt", attemptId, "--activity"]);
    const body = parseJsonOutput(stdout) as { activities: Array<{ seq: number; message: string }>; latestSeq: number };
    expect(body.activities.map((row) => row.message)).toEqual(["one", "two"]);
    expect(body.latestSeq).toBe(2);
  });

  test("filters by --after-seq", async () => {
    const { workspaceName, dbPath } = await createCliWorkspace();
    const db = await createMigratedDb(dbPath, projectRoot);
    let attemptId: string;
    try {
      ({ attemptId } = seedRunningAttempt(db));
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "one" });
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "two" });
      db.attemptActivities.appendActivity({ executionAttemptId: attemptId, kind: "assistant_message", message: "three" });
    } finally {
      db.close();
    }

    const { stdout } = await runCli([
      "tail",
      workspaceName,
      "--attempt",
      attemptId,
      "--activity",
      "--after-seq",
      "1",
    ]);
    const body = parseJsonOutput(stdout) as { activities: Array<{ seq: number; message: string }> };
    expect(body.activities.map((row) => row.seq)).toEqual([2, 3]);
  });

  test("requires --activity flag", async () => {
    const { workspaceName, dbPath } = await createCliWorkspace();
    const db = await createMigratedDb(dbPath, projectRoot);
    let attemptId: string;
    try {
      ({ attemptId } = seedRunningAttempt(db));
    } finally {
      db.close();
    }

    await expect(runCli(["tail", workspaceName, "--attempt", attemptId])).rejects.toThrow(
      /Only --activity tailing is supported/,
    );
  });
});

describe("stuck cli", () => {
  test("returns phase and needs-human breakdown", async () => {
    const { workspaceName, dbPath } = await createCliWorkspace();
    const db = await createMigratedDb(dbPath, projectRoot);
    let attemptId: string;
    try {
      ({ attemptId } = seedRunningAttempt(db));
      // Three identical command failures trigger the repeated-failure rule.
      for (let i = 0; i < 3; i += 1) {
        db.attemptActivities.appendActivity({
          executionAttemptId: attemptId,
          kind: "command_finished",
          message: "yarn typecheck",
          payload: { itemType: "command", command: "yarn typecheck", exit_code: 1 },
        });
      }
    } finally {
      db.close();
    }

    const { stdout } = await runCli(["stuck", workspaceName, "--attempt", attemptId]);
    const body = parseJsonOutput(stdout) as {
      phase: string;
      needsHuman: { isNeeded: boolean; reasons: string[] };
      repeatedFailureCandidates: Array<{ signature: string; count: number }>;
    };
    expect(body.needsHuman.isNeeded).toBe(true);
    expect(body.needsHuman.reasons).toContain("repeated_command_failure");
    expect(body.repeatedFailureCandidates[0]!.count).toBe(3);
    expect(body.phase).toBe("needs_human");
  });
});
