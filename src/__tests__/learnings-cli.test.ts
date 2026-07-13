import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { stringifyWorkspaceConfig, createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createMigratedDb, createWorkspacePaths, testProjectRoot } from "../test-support/helpers.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;
const workspacesRoot = path.join(projectRoot, "workspaces");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createCliWorkspace = async (): Promise<{ workspaceName: string; workspaceRoot: string }> => {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(workspacesRoot, "foreman-cli-test-"));
  cleanupDirs.push(workspaceRoot);
  const workspaceName = path.basename(workspaceRoot);
  const paths = createWorkspacePaths(projectRoot, workspaceRoot);

  await fs.writeFile(paths.configPath, stringifyWorkspaceConfig(createDefaultWorkspaceConfig(workspaceName, "file")), "utf8");
  await fs.writeFile(paths.envPath, "", "utf8");

  const db = await createMigratedDb(paths.dbPath, projectRoot);
  try {
    db.learnings.addLearning({
      id: "learn-b",
      title: "Planning prompt learnings note",
      repo: "shared",
      confidence: "established",
      content: "planning prompt learnings cli",
      tags: ["planning"],
    });
    db.learnings.addLearning({
      id: "learn-a",
      title: "Planning prompt learnings note",
      repo: "foreman",
      confidence: "proven",
      content: "planning prompt learnings cli",
      tags: ["planning", "cli"],
    });
    db.database.sqlite
      .prepare("UPDATE learning SET updated_at = ? WHERE id IN (?, ?)")
      .run("2026-03-16T00:00:00Z", "learn-a", "learn-b");
  } finally {
    db.close();
  }

  return { workspaceName, workspaceRoot };
};

const getLearningReadCount = async (workspaceRoot: string, id: string): Promise<number> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    const row = db.database.sqlite.prepare("SELECT read_count FROM learning WHERE id = ?").get(id) as { read_count: number } | undefined;
    return Number(row?.read_count ?? 0);
  } finally {
    db.close();
  }
};

const runCliRaw = async (args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: projectRoot });
  return stdout;
};

const runCli = async (args: string[]): Promise<unknown> => JSON.parse(await runCliRaw(args));

/**
 * One execution attempt that was handed `learn-a` and reported applying it, and a
 * second that was handed `learn-b` and did not — so the fixture pins a hit rate
 * that is neither 0 nor 1 and could not be produced by counting either half alone.
 *
 * It stamps the injection rows directly and never touches `learning.applied_count`,
 * so the measured counter and the honour-system one deliberately disagree. A stats
 * query that reads the wrong one of those two reports an empty rollup here.
 */
const seedInjectionEvents = async (workspaceRoot: string): Promise<void> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    db.workers.ensureWorkerSlots(1);
    const workerId = db.workers.listWorkers()[0]!.id;
    db.taskMirror.saveTasks(
      ["learn-a", "learn-b"].map((learningId) => ({
        id: `ENG-${learningId}`,
        provider: "file" as const,
        providerId: `ENG-${learningId}`,
        title: `Task for ${learningId}`,
        description: "",
        state: "ready" as const,
        providerState: "Todo",
        priority: "none" as const,
        labels: [],
        assignee: null,
        targets: [{ repoKey: "foreman", branchName: `eng-${learningId}`, position: 0 }],
        targetDependencies: [],
        dependencies: { taskIds: [], baseTaskId: null },
        baseBranch: null,
        pullRequests: [],
        runnerOverride: null,
        updatedAt: "2026-03-16T00:00:00Z",
        url: null,
      })),
    );

    const attemptFor = (learningId: string, applied: boolean): void => {
      const job = db.jobs.createJob({
        taskId: `ENG-${learningId}`,
        taskTargetId: db.taskMirror.getTaskTarget(`ENG-${learningId}`, "foreman")!.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: 3,
        repoKey: "foreman",
        baseBranch: "master",
        dedupeKey: `ENG-${learningId}:foreman:execution`,
        selectionReason: "ready task",
      });
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });
      db.learningInjectionEvents.recordInjection({
        attemptId: attempt.id,
        taskId: `ENG-${learningId}`,
        action: "execution",
        learnings: [{ learningId, rank: 1, cosineSimilarity: 0.82 }],
      });
      if (applied) {
        db.learningInjectionEvents.markInjectedLearningApplied({ attemptId: attempt.id, learningId });
      }
    };

    attemptFor("learn-a", true);
    attemptFor("learn-b", false);
  } finally {
    db.close();
  }
};

describe("learnings cli", () => {
  test("search returns ranked JSON results from the workspace database", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    const output = (await runCli([
      "learnings",
      "search",
      workspaceName,
      "--repo",
      "shared",
      "--repo",
      "foreman",
      "--query",
      "planning prompt",
      "--query",
      "learnings cli",
    ])) as {
      workspace: string;
      repos: string[];
      queries: string[];
      learnings: Array<{ id: string; score: number; content?: string }>;
    };

    expect(output.workspace).toBe(workspaceName);
    expect(output.repos).toEqual(["shared", "foreman"]);
    expect(output.queries).toEqual(["planning prompt", "learnings cli"]);
    expect(output.learnings.map((learning) => learning.id).sort()).toEqual(["learn-a", "learn-b"]);
    expect(output.learnings.every((learning) => Number.isFinite(learning.score))).toBe(true);
    expect(output.learnings[0]!.score).toBeLessThanOrEqual(output.learnings[1]!.score);
    expect(output.learnings.every((learning) => !("content" in learning))).toBe(true);
    expect(await getLearningReadCount(workspaceRoot, "learn-a")).toBe(1);
    expect(await getLearningReadCount(workspaceRoot, "learn-b")).toBe(1);
  });

  test("get returns requested learning details as JSON", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    const output = (await runCli([
      "learnings",
      "get",
      workspaceName,
      "--id",
      "learn-b",
      "--id",
      "learn-a",
      "--id",
      "missing",
    ])) as {
      ids: string[];
      missingIds: string[];
      learnings: Array<{ id: string; content: string }>;
    };

    expect(output.ids).toEqual(["learn-b", "learn-a", "missing"]);
    expect(output.learnings.map((learning) => learning.id)).toEqual(["learn-b", "learn-a"]);
    expect(output.learnings[0]?.content).toBe("planning prompt learnings cli");
    expect(output.missingIds).toEqual(["missing"]);
    expect(await getLearningReadCount(workspaceRoot, "learn-a")).toBe(1);
    expect(await getLearningReadCount(workspaceRoot, "learn-b")).toBe(1);
  });

  test("injection-stats reports the two exit metrics as structured JSON fields", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();
    await seedInjectionEvents(workspaceRoot);

    const output = (await runCli(["learnings", "injection-stats", workspaceName, "--json"])) as {
      workspace: string;
      since: string | null;
      eligibleAttempts: number;
      attemptsWithInjection: number;
      attemptsWithInjectionRate: number;
      injectedLearnings: number;
      appliedLearnings: number;
      hitRate: number;
      topAppliedLearnings: Array<{ learningId: string; injectedCount: number; appliedCount: number }>;
    };

    expect(output.workspace).toBe(workspaceName);
    expect(output.since).toBeNull();
    expect(output.eligibleAttempts).toBe(2);
    expect(output.attemptsWithInjection).toBe(2);
    expect(output.attemptsWithInjectionRate).toBe(1);
    expect(output.injectedLearnings).toBe(2);
    expect(output.appliedLearnings).toBe(1);
    expect(output.hitRate).toBe(0.5);
    expect(output.topAppliedLearnings).toEqual([{ learningId: "learn-a", title: "Planning prompt learnings note", injectedCount: 1, appliedCount: 1 }]);
  });

  test("injection-stats renders a table when --json is absent", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();
    await seedInjectionEvents(workspaceRoot);

    const output = await runCliRaw(["learnings", "injection-stats", workspaceName]);

    expect(output).toContain("Attempts with injection");
    expect(output).toContain("Learnings applied");
    expect(output).toContain("50.0%");
    expect(output).toContain("learn-a");
  });

  test("package.json exposes the built CLI through pnpm run foreman", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.foreman).toBe("node dist/cli.js");
  });
});
