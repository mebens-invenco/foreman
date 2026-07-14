import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { stringifyWorkspaceConfig, createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createMigratedDb, createWorkspacePaths, testProjectRoot } from "../test-support/helpers.js";
import type { LearningSearchEventRecord } from "../repos/index.js";

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;
const workspacesRoot = path.join(projectRoot, "workspaces");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createCliWorkspace = async (): Promise<{ workspaceName: string; workspaceRoot: string }> => {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(workspacesRoot, "foreman-telemetry-test-"));
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
  } finally {
    db.close();
  }

  return { workspaceName, workspaceRoot };
};

/**
 * The provenance vars are stripped from the inherited env before each run, then
 * put back only when the test asks for them. Without the strip, a suite running
 * inside a Foreman worker session would inherit that session's real
 * FOREMAN_ATTEMPT_ID and the ad-hoc case below would silently stop testing
 * anything — it would be a worker-session run wearing an ad-hoc test's name.
 */
const runCli = async (args: string[], provenance?: Record<string, string>): Promise<unknown> => {
  const { FOREMAN_ATTEMPT_ID: _attempt, FOREMAN_TASK_ID: _task, ...ambient } = process.env;
  const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: projectRoot,
    env: { ...ambient, ...provenance },
  });
  return JSON.parse(stdout);
};

const readEvents = async (workspaceRoot: string): Promise<LearningSearchEventRecord[]> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    return db.learningSearchEvents.listEvents();
  } finally {
    db.close();
  }
};

const getLearningReadCount = async (workspaceRoot: string, id: string): Promise<number> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    const row = db.database.sqlite.prepare("SELECT read_count FROM learning WHERE id = ?").get(id) as
      | { read_count: number }
      | undefined;
    return Number(row?.read_count ?? 0);
  } finally {
    db.close();
  }
};

describe("learning search telemetry", () => {
  test("records a search event with the hits, scores, scopes, and caller", async () => {
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
      "--caller",
      "plan",
    ])) as { learnings: Array<{ id: string; score: number }> };

    const events = await readEvents(workspaceRoot);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("search");
    expect(event.caller).toBe("plan");
    expect(event.queries).toEqual(["planning prompt", "learnings cli"]);
    expect(event.repos).toEqual(["shared", "foreman"]);
    expect(event.requestedIds).toEqual([]);
    // Both learnings match, and the event's parallel arrays mirror the CLI's returned
    // (id, score) pairs position-for-position — pinning that hitScores[i] is the score of
    // hitIds[i] through the DB round-trip, so a future re-rank/dedupe cannot silently
    // misattribute scores to ids without failing here.
    const returnedIds = output.learnings.map((learning) => learning.id);
    expect(returnedIds).toContain("learn-a");
    expect(returnedIds).toContain("learn-b");
    expect(event.hitIds).toEqual(returnedIds);
    expect(event.hitScores).toEqual(output.learnings.map((learning) => learning.score));
    expect(event.hitScores.every((score) => Number.isFinite(score))).toBe(true);
    expect(event.zeroHit).toBe(false);
  });

  test("records a zero-hit search with an empty hit set and null caller", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    const output = (await runCli([
      "learnings",
      "search",
      workspaceName,
      "--query",
      "zzznomatchxyz",
    ])) as { learnings: unknown[] };

    expect(output.learnings).toEqual([]);

    const events = await readEvents(workspaceRoot);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("search");
    expect(event.caller).toBeNull();
    expect(event.queries).toEqual(["zzznomatchxyz"]);
    expect(event.hitIds).toEqual([]);
    expect(event.hitScores).toEqual([]);
    expect(event.zeroHit).toBe(true);
  });

  test("records a get event with requested ids and only the found hits", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    await runCli(["learnings", "get", workspaceName, "--id", "learn-b", "--id", "learn-a", "--id", "missing"]);

    const events = await readEvents(workspaceRoot);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("get");
    expect(event.caller).toBeNull();
    expect(event.requestedIds).toEqual(["learn-b", "learn-a", "missing"]);
    expect(event.hitIds).toEqual(["learn-b", "learn-a"]);
    expect(event.zeroHit).toBe(false);
  });

  test("records the caller on a get event when provided", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    // `search` and `get` register `--caller` independently, so exercise it on `get` too:
    // a regression in the get wiring would otherwise null every get caller with the suite green.
    await runCli(["learnings", "get", workspaceName, "--id", "learn-a", "--caller", "reviewer"]);

    const events = await readEvents(workspaceRoot);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("get");
    expect(event.caller).toBe("reviewer");
    expect(event.requestedIds).toEqual(["learn-a"]);
    expect(event.hitIds).toEqual(["learn-a"]);
  });

  test("a telemetry insert failure does not fail the search", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    // Drop the telemetry table but keep its schema_migration row, so the CLI's
    // runMigrations leaves it dropped and the event insert hits "no such table".
    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
    try {
      db.database.sqlite.exec("DROP TABLE learning_search_event");
    } finally {
      db.close();
    }

    const output = (await runCli([
      "learnings",
      "search",
      workspaceName,
      "--query",
      "planning prompt",
      "--query",
      "learnings cli",
    ])) as { learnings: Array<{ id: string }> };

    // The search still returns its results and still increments read counts...
    expect([...output.learnings.map((learning) => learning.id)].sort()).toEqual(["learn-a", "learn-b"]);
    expect(await getLearningReadCount(workspaceRoot, "learn-a")).toBe(1);
    expect(await getLearningReadCount(workspaceRoot, "learn-b")).toBe(1);
  });

  test("listEvents filters by kind and zero-hit flag", async () => {
    const { workspaceRoot } = await createCliWorkspace();
    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
    try {
      db.learningSearchEvents.recordEvent({
        kind: "search",
        caller: "execution",
        queries: ["hit topic"],
        repos: ["shared"],
        hitIds: ["learn-a"],
        hitScores: [-1.2],
      });
      db.learningSearchEvents.recordEvent({ kind: "search", queries: ["empty topic"], hitIds: [] });
      db.learningSearchEvents.recordEvent({ kind: "get", requestedIds: ["learn-a"], hitIds: ["learn-a"] });

      expect(db.learningSearchEvents.listEvents({ kind: "get" }).map((event) => event.kind)).toEqual(["get"]);
      const zeroHits = db.learningSearchEvents.listEvents({ zeroHit: true });
      expect(zeroHits).toHaveLength(1);
      expect(zeroHits[0]!.queries).toEqual(["empty topic"]);
      expect(db.learningSearchEvents.listEvents({ caller: "execution" }).map((event) => event.caller)).toEqual([
        "execution",
      ]);
    } finally {
      db.close();
    }
  });
});

describe("learning search attempt provenance", () => {
  const workerSession = { FOREMAN_ATTEMPT_ID: "attempt-1", FOREMAN_TASK_ID: "ENG-A" };

  test("a search inside a worker session is stamped with the attempt and task from the env", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    await runCli(["learnings", "search", workspaceName, "--query", "planning prompt"], workerSession);

    expect(await readEvents(workspaceRoot)).toEqual([
      expect.objectContaining({ kind: "search", attemptId: "attempt-1", taskId: "ENG-A" }),
    ]);
  });

  test("a get inside a worker session is stamped the same way", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    await runCli(["learnings", "get", workspaceName, "--id", "learn-a"], workerSession);

    expect(await readEvents(workspaceRoot)).toEqual([
      expect.objectContaining({ kind: "get", attemptId: "attempt-1", taskId: "ENG-A" }),
    ]);
  });

  test("a human running the CLI by hand stamps NULL, and is excluded from the distinct-task counts", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    await runCli(["learnings", "search", workspaceName, "--query", "planning prompt"]);

    expect(await readEvents(workspaceRoot)).toEqual([expect.objectContaining({ attemptId: null, taskId: null })]);

    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
    try {
      expect(db.learningUsage.getUsageStats()).toMatchObject({ learnings: [], unattributedReadEvents: 1 });
    } finally {
      db.close();
    }
  });

  // Half a stamp is not a weaker signal, it is an uncountable one: the reader takes
  // the pair or nothing, so a partial env reads as ad-hoc use.
  test("an env carrying only the attempt stamps neither", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();

    await runCli(["learnings", "search", workspaceName, "--query", "planning prompt"], {
      FOREMAN_ATTEMPT_ID: "attempt-1",
    });

    expect(await readEvents(workspaceRoot)).toEqual([expect.objectContaining({ attemptId: null, taskId: null })]);
  });
});
