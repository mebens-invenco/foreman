import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import type { Task } from "../domain/index.js";
import { stringifyWorkspaceConfig, createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createMigratedDb, createWorkspacePaths, testProjectRoot } from "../test-support/helpers.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;
const workspacesRoot = path.join(projectRoot, "workspaces");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createCliWorkspace = async () => {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(workspacesRoot, "foreman-usage-cli-"));
  cleanupDirs.push(workspaceRoot);
  const workspaceName = path.basename(workspaceRoot);
  const paths = createWorkspacePaths(projectRoot, workspaceRoot);

  await fs.writeFile(paths.configPath, stringifyWorkspaceConfig(createDefaultWorkspaceConfig(workspaceName, "file")), "utf8");
  await fs.writeFile(paths.envPath, "", "utf8");

  const db = await createMigratedDb(paths.dbPath, projectRoot);
  try {
    const task: Task = {
      id: "TASK-USAGE",
      provider: "file",
      providerId: "TASK-USAGE",
      title: "Usage seed task",
      description: "",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      labels: [],
      assignee: null,
      targets: [{ repoKey: "repo-a", branchName: "task-usage", position: 0 }],
      targetDependencies: [],
      dependencies: { taskIds: [], baseTaskId: null },
      baseBranch: null,
      runnerOverride: null,
      pullRequests: [],
      updatedAt: "2026-05-20T00:00:00Z",
      url: null,
    };
    db.taskMirror.saveTasks([task]);
    const target = db.taskMirror.getTaskTarget(task.id, "repo-a")!;
    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0]!;
    const job = db.jobs.createJob({
      taskId: task.id,
      taskTargetId: target.id,
      taskProvider: "file",
      action: "execution",
      priorityRank: 3,
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${task.id}:usage`,
      selectionReason: "test",
    });
    const insert = db.database.sqlite.prepare(
      `INSERT INTO execution_attempt(
        id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id,
        status, started_at, finished_at, exit_code, signal, summary, error_message, tokens_used_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "att-day1",
      job.id,
      worker.id,
      1,
      "claude",
      "claude-opus-4-7",
      "high",
      null,
      "completed",
      "2026-05-20T10:00:00.000Z",
      "2026-05-20T10:00:00.000Z",
      0,
      null,
      "",
      null,
      JSON.stringify({ inputTokens: 0, outputTokens: 1_000_000 }),
    );
    insert.run(
      "att-day2",
      job.id,
      worker.id,
      2,
      "claude",
      "claude-opus-4-7",
      "high",
      null,
      "completed",
      "2026-05-21T10:00:00.000Z",
      "2026-05-21T10:00:00.000Z",
      0,
      null,
      "",
      null,
      JSON.stringify({ inputTokens: 1_000_000, outputTokens: 0 }),
    );
  } finally {
    db.close();
  }

  return { workspaceName, workspaceRoot };
};

const runCli = async (args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: projectRoot });
  return stdout;
};

describe("usage cli", () => {
  test("emits a JSON rollup matching the seeded window when --json is set", async () => {
    const { workspaceName } = await createCliWorkspace();

    const stdout = await runCli([
      "usage",
      workspaceName,
      "--from",
      "2026-05-20",
      "--to",
      "2026-05-21",
      "--by",
      "day",
      "--json",
    ]);
    const payload = JSON.parse(stdout) as {
      workspace: string;
      fromDate: string;
      toDate: string;
      groupBy: string;
      buckets: Array<{ groupKey: string; attemptsCount: number; cost: { totalUsd: number } }>;
      totals: { attemptsCount: number; cost: { totalUsd: number } };
    };

    expect(payload.workspace).toBe(workspaceName);
    expect(payload.fromDate).toBe("2026-05-20");
    expect(payload.toDate).toBe("2026-05-21");
    expect(payload.groupBy).toBe("day");
    expect(payload.buckets).toHaveLength(2);
    expect(payload.buckets[0]!.groupKey).toBe("2026-05-20");
    expect(payload.buckets[0]!.cost.totalUsd).toBeCloseTo(75);
    expect(payload.buckets[1]!.groupKey).toBe("2026-05-21");
    expect(payload.buckets[1]!.cost.totalUsd).toBeCloseTo(15);
    expect(payload.totals.attemptsCount).toBe(2);
    expect(payload.totals.cost.totalUsd).toBeCloseTo(90);
  });

  test("emits a tab-aligned table by default", async () => {
    const { workspaceName } = await createCliWorkspace();

    const stdout = await runCli([
      "usage",
      workspaceName,
      "--from",
      "2026-05-20",
      "--to",
      "2026-05-21",
    ]);

    expect(stdout).toContain("Usage 2026-05-20 to 2026-05-21");
    expect(stdout).toContain("Day");
    expect(stdout).toContain("Cost USD");
    expect(stdout).toContain("$90.00");
    expect(stdout).toContain("TOTAL");
  });
});
