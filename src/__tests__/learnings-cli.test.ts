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

const getLearningFlags = async (
  workspaceRoot: string,
  id: string,
): Promise<{ archivedAt: string | null; duplicateOf: string | null } | undefined> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    const [learning] = db.learnings.getLearningsByIds([id]);
    return learning ? { archivedAt: learning.archivedAt, duplicateOf: learning.duplicateOf } : undefined;
  } finally {
    db.close();
  }
};

// The CLI reads the workspace's live embedder id, so the fixture vectors must be
// stored under that model. They are hand-built 3-dim vectors, never the real
// 384-dim model output, so the scan runs without any model download.
const CONSOLIDATION_MODEL = "bge-small-en-v1.5";
const unitVectorAt = (cosine: number): number[] => [cosine, Math.sqrt(1 - cosine * cosine), 0];

const createConsolidationWorkspace = async (): Promise<{ workspaceName: string; workspaceRoot: string }> => {
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(workspacesRoot, "foreman-cli-consolidate-"));
  cleanupDirs.push(workspaceRoot);
  const workspaceName = path.basename(workspaceRoot);
  const paths = createWorkspacePaths(projectRoot, workspaceRoot);

  await fs.writeFile(paths.configPath, stringifyWorkspaceConfig(createDefaultWorkspaceConfig(workspaceName, "file")), "utf8");
  await fs.writeFile(paths.envPath, "", "utf8");

  const db = await createMigratedDb(paths.dbPath, projectRoot);
  try {
    const seed = (id: string, vector: number[], updatedAt: string): void => {
      const content = `body ${id}`;
      db.learnings.addLearning({ id, title: `Title ${id}`, repo: "shared", confidence: "emerging", content, tags: [] });
      db.learnings.upsertLearningEmbedding({
        learningId: id,
        model: CONSOLIDATION_MODEL,
        dims: 3,
        vector: Float32Array.from(vector),
        embeddedTitle: `Title ${id}`,
        embeddedContent: content,
      });
      db.database.sqlite.prepare("UPDATE learning SET updated_at = ? WHERE id = ?").run(updatedAt, id);
    };
    // dup-old / dup-new are near-identical (cosine 0.9151); distinct is orthogonal.
    // No usage, so recency picks dup-new as survivor.
    seed("dup-old", [1, 0, 0], "2026-07-09T00:00:00.000Z");
    seed("dup-new", unitVectorAt(0.9151), "2026-07-13T00:00:00.000Z");
    seed("distinct", [0, 0, 1], "2026-07-10T00:00:00.000Z");
  } finally {
    db.close();
  }

  return { workspaceName, workspaceRoot };
};

const runCliRaw = async (args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", "src/cli.ts", ...args], { cwd: projectRoot });
  return stdout;
};

const runCli = async (args: string[]): Promise<unknown> => JSON.parse(await runCliRaw(args));

const usageTask = (id: string): Task => ({
  id,
  provider: "file",
  providerId: id,
  title: `Task ${id}`,
  description: "",
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "foreman", branchName: id.toLowerCase(), position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-03-16T00:00:00Z",
  url: null,
});

/**
 * ENG-SELF extracted `learn-a` and then two of its own stages read and applied it
 * — the self-echo, and under the raw counters alone it is indistinguishable from
 * a learning two tasks found useful. ENG-OTHER's single use is the only real
 * cross-task signal in the fixture, so every corrected count must come back as 1
 * while the raw counters stay at 3+.
 */
const seedUsageEvents = async (workspaceRoot: string): Promise<void> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    db.database.sqlite.prepare("UPDATE learning SET source_task_id = ? WHERE id = ?").run("ENG-SELF", "learn-a");

    const read = (attemptId: string, taskId: string, learningIds: string[]): void => {
      db.learnings.getLearningsByIds(learningIds, { incrementReadCount: true });
      db.learningSearchEvents.recordEvent({
        kind: "search",
        queries: ["planning prompt"],
        hitIds: learningIds,
        source: { attemptId, taskId },
      });
    };
    const apply = (attemptId: string, taskId: string, learningId: string): void => {
      db.learnings.updateLearning({ id: learningId, markApplied: true });
      db.learningUsage.recordApplied({ attemptId, taskId, action: "execution", learningId });
    };

    for (const action of ["execution", "review"] as const) {
      const attempt = seedExecutionAttempt(db, { task: usageTask("ENG-SELF"), repoKey: "foreman", action });
      read(attempt.id, "ENG-SELF", ["learn-a", "learn-b"]);
      apply(attempt.id, "ENG-SELF", "learn-a");
    }

    const other = seedExecutionAttempt(db, { task: usageTask("ENG-OTHER"), repoKey: "foreman", action: "execution" });
    read(other.id, "ENG-OTHER", ["learn-a"]);
    apply(other.id, "ENG-OTHER", "learn-a");

    db.learnings.getLearningsByIds(["learn-a"], { incrementReadCount: true });
    db.learningSearchEvents.recordEvent({ kind: "search", queries: ["planning prompt"], hitIds: ["learn-a"] });
  } finally {
    db.close();
  }
};

/**
 * One execution attempt that was handed `learn-a` and reported applying it, and a
 * second that was handed `learn-b` and did not — so the fixture pins a hit rate
 * that is neither 0 nor 1 and could not be produced by counting either half alone.
 *
 * It stamps the injection rows directly and never touches `learning.applied_count`,
 * so the measured counter and the honour-system one deliberately disagree. A stats
 * query that reads the wrong one of those two reports an empty rollup here.
 */
const seedInjectionEvents = async (workspaceRoot: string): Promise<Record<string, string>> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  const attemptIds: Record<string, string> = {};
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
      attemptIds[learningId] = attempt.id;
    };

    attemptFor("learn-a", true);
    attemptFor("learn-b", false);
  } finally {
    db.close();
  }

  return attemptIds;
};

const backdateAttempt = async (workspaceRoot: string, attemptId: string, startedAt: string): Promise<void> => {
  const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), projectRoot);
  try {
    db.database.sqlite.prepare("UPDATE execution_attempt SET started_at = ? WHERE id = ?").run(startedAt, attemptId);
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

  test("archive drops a learning from search but keeps it resolvable, and unarchive restores it", async () => {
    const { workspaceName } = await createCliWorkspace();

    const archived = (await runCli(["learnings", "archive", workspaceName, "learn-a"])) as {
      archived: boolean;
      learning: { id: string; archivedAt: string | null };
    };
    expect(archived.archived).toBe(true);
    expect(archived.learning.archivedAt).toEqual(expect.any(String));

    const afterArchive = (await runCli(["learnings", "search", workspaceName, "--query", "planning prompt"])) as {
      learnings: Array<{ id: string }>;
    };
    expect(afterArchive.learnings.map((learning) => learning.id)).toEqual(["learn-b"]);

    // An id in hand still resolves the archived learning.
    const fetched = (await runCli(["learnings", "get", workspaceName, "--id", "learn-a"])) as {
      learnings: Array<{ id: string; archivedAt: string | null }>;
    };
    expect(fetched.learnings[0]?.archivedAt).toEqual(expect.any(String));

    const unarchived = (await runCli(["learnings", "unarchive", workspaceName, "learn-a"])) as {
      archived: boolean;
      learning: { archivedAt: string | null };
    };
    expect(unarchived.archived).toBe(false);
    expect(unarchived.learning.archivedAt).toBeNull();

    const afterUnarchive = (await runCli(["learnings", "search", workspaceName, "--query", "planning prompt"])) as {
      learnings: Array<{ id: string }>;
    };
    expect(afterUnarchive.learnings.map((learning) => learning.id).sort()).toEqual(["learn-a", "learn-b"]);
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

  test("injection-stats --since normalizes the boundary and actually filters on it", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();
    const attemptIds = await seedInjectionEvents(workspaceRoot);
    // Only `learn-b`'s attempt falls outside the window; `learn-a`'s — the applied
    // one — stays inside it.
    await backdateAttempt(workspaceRoot, attemptIds["learn-b"]!, "2020-01-01T00:00:00.000Z");

    const output = (await runCli([
      "learnings",
      "injection-stats",
      workspaceName,
      "--since",
      "2026-01-01",
      "--json",
    ])) as { since: string; eligibleAttempts: number; injectedLearnings: number; appliedLearnings: number; hitRate: number };

    // A `since` echoed back un-normalized would still be string-compared against
    // ISO instants, match nothing, and report zeros with exit code 0.
    expect(output.since).toBe("2026-01-01T00:00:00.000Z");
    expect(output.eligibleAttempts).toBe(1);
    expect(output.injectedLearnings).toBe(1);
    expect(output.appliedLearnings).toBe(1);
    expect(output.hitRate).toBe(1);
  });

  test("injection-stats rejects a --since it cannot parse", async () => {
    const { workspaceName } = await createCliWorkspace();

    await expect(runCliRaw(["learnings", "injection-stats", workspaceName, "--since", "not-a-date", "--json"])).rejects.toThrow(
      /ISO-8601/,
    );
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

  test("usage-stats reports the task-distinct counts as structured JSON fields", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();
    await seedUsageEvents(workspaceRoot);

    const output = (await runCli(["learnings", "usage-stats", workspaceName, "--json"])) as {
      workspace: string;
      since: string | null;
      unattributedReadEvents: number;
      learnings: Array<{
        learningId: string;
        sourceTaskId: string | null;
        readCount: number;
        appliedCount: number;
        distinctTasksRead: number;
        distinctTasksApplied: number;
        selfEchoReads: number;
        selfEchoApplies: number;
      }>;
    };

    expect(output.workspace).toBe(workspaceName);
    expect(output.since).toBeNull();
    // The ad-hoc search: no attempt, so no task, so out of every distinct count.
    expect(output.unattributedReadEvents).toBe(1);
    expect(output.learnings).toEqual([
      // ENG-SELF extracted learn-a, then two of its own stages read AND applied it.
      // Every one of those touches is echo; only ENG-OTHER's use is real signal.
      {
        learningId: "learn-a",
        title: "Planning prompt learnings note",
        repo: "foreman",
        sourceTaskId: "ENG-SELF",
        readCount: 4,
        appliedCount: 3,
        distinctTasksRead: 1,
        distinctTasksApplied: 1,
        selfEchoReads: 2,
        selfEchoApplies: 2,
      },
      // Read by both of ENG-SELF's stages — pipeline depth, one task.
      {
        learningId: "learn-b",
        title: "Planning prompt learnings note",
        repo: "shared",
        sourceTaskId: null,
        readCount: 2,
        appliedCount: 0,
        distinctTasksRead: 1,
        distinctTasksApplied: 0,
        selfEchoReads: 0,
        selfEchoApplies: 0,
      },
    ]);
  });

  test("usage-stats renders a table when --json is absent", async () => {
    const { workspaceName, workspaceRoot } = await createCliWorkspace();
    await seedUsageEvents(workspaceRoot);

    const output = await runCliRaw(["learnings", "usage-stats", workspaceName]);

    expect(output).toContain("Task-distinct learning usage");
    expect(output).toContain("Unattributed read events");
    expect(output).toContain("Tasks applied");
    expect(output).toContain("Echo r/a");
    expect(output).toContain("learn-a");
  });

  test("usage-stats rejects a --since it cannot parse", async () => {
    const { workspaceName } = await createCliWorkspace();

    await expect(runCliRaw(["learnings", "usage-stats", workspaceName, "--since", "not-a-date", "--json"])).rejects.toThrow(
      /ISO-8601/,
    );
  });

  test("consolidate --json proposes the near-duplicate cluster and writes nothing by default", async () => {
    const { workspaceName, workspaceRoot } = await createConsolidationWorkspace();

    const output = (await runCli(["learnings", "consolidate", workspaceName, "--json"])) as {
      workspace: string;
      threshold: number;
      applied: boolean;
      scanned: number;
      corpus: number;
      clusters: Array<{
        survivorId: string;
        survivorReason: string;
        loserIds: string[];
        members: Array<{ id: string; title: string; repo: string; distinctTasksApplied: number; updatedAt: string }>;
        pairwiseSimilarities: Array<{ left: string; right: string; similarity: number }>;
      }>;
    };

    expect(output.workspace).toBe(workspaceName);
    expect(output.threshold).toBe(0.91);
    expect(output.applied).toBe(false);
    expect(output.scanned).toBe(3);
    expect(output.corpus).toBe(3);
    expect(output.clusters).toHaveLength(1);

    const cluster = output.clusters[0]!;
    expect(cluster.survivorId).toBe("dup-new");
    expect(cluster.survivorReason).toBe("recency_tiebreak");
    expect(cluster.loserIds).toEqual(["dup-old"]);
    expect(cluster.members.map((member) => member.id)).toEqual(["dup-new", "dup-old"]);
    expect(cluster.members[0]).toMatchObject({ id: "dup-new", repo: "shared", distinctTasksApplied: 0 });
    expect(cluster.pairwiseSimilarities).toHaveLength(1);
    expect(cluster.pairwiseSimilarities[0]).toMatchObject({ left: "dup-new", right: "dup-old" });
    expect(cluster.pairwiseSimilarities[0]!.similarity).toBeGreaterThanOrEqual(0.91);

    // Dry run by default: no learning was archived or flagged.
    expect(await getLearningFlags(workspaceRoot, "dup-old")).toEqual({ archivedAt: null, duplicateOf: null });
    expect(await getLearningFlags(workspaceRoot, "dup-new")).toEqual({ archivedAt: null, duplicateOf: null });
  });

  test("consolidate --apply archives the loser with duplicate_of set, and a re-run is idempotent", async () => {
    const { workspaceName, workspaceRoot } = await createConsolidationWorkspace();

    const applied = (await runCli(["learnings", "consolidate", workspaceName, "--apply", "--json"])) as {
      applied: boolean;
      clusters: Array<{ survivorId: string; loserIds: string[] }>;
    };
    expect(applied.applied).toBe(true);
    expect(applied.clusters[0]).toMatchObject({ survivorId: "dup-new", loserIds: ["dup-old"] });

    expect(await getLearningFlags(workspaceRoot, "dup-old")).toEqual({
      archivedAt: expect.any(String),
      duplicateOf: "dup-new",
    });
    expect(await getLearningFlags(workspaceRoot, "dup-new")).toEqual({ archivedAt: null, duplicateOf: null });

    // The archived loser has left the corpus, so a second scan proposes nothing.
    const rerun = (await runCli(["learnings", "consolidate", workspaceName, "--json"])) as { clusters: unknown[] };
    expect(rerun.clusters).toEqual([]);
  });

  test("consolidate renders a human report when --json is absent", async () => {
    const { workspaceName } = await createConsolidationWorkspace();

    const output = await runCliRaw(["learnings", "consolidate", workspaceName]);

    expect(output).toContain("dry run");
    expect(output).toContain("scanned 3 of 3 learnings");
    expect(output).toContain("survivor dup-new");
    expect(output).toContain("dup-old");
    expect(output).toContain("repo=shared");
  });
});
