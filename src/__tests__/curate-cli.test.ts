import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import type { Task } from "../domain/index.js";
import { stringifyWorkspaceConfig, createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createMigratedDb, createWorkspacePaths, seedExecutionAttempt, testProjectRoot } from "../test-support/helpers.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;
const workspacesRoot = path.join(projectRoot, "workspaces");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Db = Awaited<ReturnType<typeof createMigratedDb>>;

const taskNamed = (id: string): Task => ({
  id,
  provider: "file",
  providerId: id,
  title: `task ${id}`,
  description: "",
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "repo-a", branchName: id.toLowerCase(), position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-07-14T00:00:00Z",
  url: null,
});

const applyIn = (db: Db, input: { task: Task; learningId: string }): void => {
  const attempt = seedExecutionAttempt(db, { task: input.task, repoKey: "repo-a", action: "execution" });
  db.learnings.updateLearning({ id: input.learningId, markApplied: true });
  db.learningUsage.recordApplied({ attemptId: attempt.id, taskId: input.task.id, action: "execution", learningId: input.learningId });
};

const createCliWorkspace = async (): Promise<{ workspaceName: string; workspaceRoot: string }> => {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(workspacesRoot, "foreman-curate-cli-"));
  cleanupDirs.push(workspaceRoot);
  const workspaceName = path.basename(workspaceRoot);
  const paths = createWorkspacePaths(projectRoot, workspaceRoot);

  await fs.writeFile(paths.configPath, stringifyWorkspaceConfig(createDefaultWorkspaceConfig(workspaceName, "file")), "utf8");
  await fs.writeFile(paths.envPath, "", "utf8");

  const db = await createMigratedDb(paths.dbPath, projectRoot);
  try {
    // Two distinct tasks apply this — the distinct-task promotion signal, self-echo
    // free (no source task) — so it earns `established`.
    db.learnings.addLearning({ id: "promote-me", title: "Earned by two tasks", repo: "shared", confidence: "emerging", content: "c", tags: [] });
    applyIn(db, { task: taskNamed("ENG-A"), learningId: "promote-me" });
    applyIn(db, { task: taskNamed("ENG-B"), learningId: "promote-me" });

    // Aged and never used, but the usage epoch is barely a day old in real time, so
    // the epoch grace must keep it OFF every decay proposal.
    db.learnings.addLearning({ id: "aged-quiet", title: "Old and silent", repo: "shared", confidence: "emerging", content: "c", tags: [] });
    db.database.sqlite
      .prepare("UPDATE learning SET created_at = ? WHERE id = ?")
      .run("2026-01-01T00:00:00.000Z", "aged-quiet");
  } finally {
    db.close();
  }

  return { workspaceName, workspaceRoot };
};

const runCurate = async (workspace: string, extraArgs: string[]): Promise<{ applied: boolean; proposals: Array<Record<string, unknown>> }> => {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", "learnings", "curate", workspace, "--json", ...extraArgs], {
    cwd: projectRoot,
  });
  return JSON.parse(stdout) as { applied: boolean; proposals: Array<Record<string, unknown>> };
};

const confidenceOf = async (workspaceRoot: string, id: string): Promise<{ confidence: string; archivedAt: string | null }> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    const row = db.database.sqlite.prepare("SELECT confidence, archived_at FROM learning WHERE id = ?").get(id) as
      | { confidence: string; archived_at: string | null }
      | undefined;
    return { confidence: row!.confidence, archivedAt: row!.archived_at };
  } finally {
    db.close();
  }
};

describe("learnings curate CLI", () => {
  test("dry run lists every transition with its evidence and writes nothing", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    const payload = await runCurate(workspaceName, []);

    expect(payload.applied).toBe(false);
    expect(payload.proposals).toEqual([
      expect.objectContaining({ kind: "promote", learningId: "promote-me", from: "emerging", to: "established", distinctTasksApplied: 2 }),
    ]);
    // The epoch grace keeps the aged learning off the proposal entirely.
    expect(payload.proposals.some((proposal) => proposal.learningId === "aged-quiet")).toBe(false);

    // Dry run is inert: the store is exactly as seeded.
    expect(await confidenceOf(workspaceRoot, "promote-me")).toEqual({ confidence: "emerging", archivedAt: null });
    expect(await confidenceOf(workspaceRoot, "aged-quiet")).toEqual({ confidence: "emerging", archivedAt: null });
  });

  test("--apply executes the promotion and reports what changed", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    const payload = await runCurate(workspaceName, ["--apply"]);

    expect(payload.applied).toBe(true);
    expect(payload.proposals).toEqual([
      expect.objectContaining({ kind: "promote", learningId: "promote-me", to: "established" }),
    ]);

    // The confidence-only update leaves the row active and un-archived.
    expect(await confidenceOf(workspaceRoot, "promote-me")).toEqual({ confidence: "established", archivedAt: null });
    expect(await confidenceOf(workspaceRoot, "aged-quiet")).toEqual({ confidence: "emerging", archivedAt: null });
  });

  test("the tab-aligned default output names the transition and its evidence", async () => {
    const { workspaceName } = await createCliWorkspace();

    const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", "learnings", "curate", workspaceName], {
      cwd: projectRoot,
    });

    expect(stdout).toContain("dry run");
    expect(stdout).toContain("promote");
    expect(stdout).toContain("promote-me");
    expect(stdout).toContain("2 distinct tasks applied it");
  });
});
