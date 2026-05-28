import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createHttpServer } from "../http.js";
import { createDefaultWorkspaceConfig } from "../workspace/config.js";
import {
  createMigratedDb,
  createTempDir,
  createWorkspacePaths,
  testProjectRoot,
} from "../test-support/helpers.js";
import type { ForemanRepos } from "../repos/index.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const buildServer = async (): Promise<{
  server: ReturnType<typeof createHttpServer>;
  db: ForemanRepos;
  workspaceRoot: string;
}> => {
  const workspaceRoot = await createTempDir("foreman-http-attempt-status-");
  cleanupDirs.push(workspaceRoot);
  const paths = createWorkspacePaths(projectRoot, workspaceRoot);
  const db = await createMigratedDb(paths.dbPath, projectRoot);

  const server = createHttpServer({
    config: createDefaultWorkspaceConfig("foo", "file"),
    paths,
    repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
    repos: db,
    taskSystem: {
      listCandidates: vi.fn(async () => []),
      getTask: vi.fn(),
      listComments: vi.fn(async () => []),
    } as any,
    reviewService: {
      resolvePullRequest: vi.fn(async () => null),
    } as any,
    scheduler: {
      getStatus: () => ({ status: "running", nextScoutPollAt: null }),
      start: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(async () => undefined),
      stopAttempt: vi.fn(),
      triggerManualScout: vi.fn(),
    } as any,
  });

  return { server, db, workspaceRoot };
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

describe("attempt activity HTTP", () => {
  test("paginates activities by afterSeq", async () => {
    const { server, db } = await buildServer();

    try {
      const { attemptId } = seedRunningAttempt(db);
      for (let index = 0; index < 5; index += 1) {
        db.attemptActivities.appendActivity({
          executionAttemptId: attemptId,
          kind: "assistant_message",
          message: `message ${index}`,
        });
      }

      const firstPage = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?limit=2`,
      });
      expect(firstPage.statusCode).toBe(200);
      const firstBody = firstPage.json();
      expect(firstBody.activities).toHaveLength(2);
      expect(firstBody.activities.map((row: { seq: number }) => row.seq)).toEqual([1, 2]);
      expect(firstBody.latestSeq).toBe(2);
      expect(firstBody.totalActivities).toBe(5);

      const nextPage = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?afterSeq=${firstBody.latestSeq}&limit=2`,
      });
      expect(nextPage.statusCode).toBe(200);
      const nextBody = nextPage.json();
      expect(nextBody.activities.map((row: { seq: number }) => row.seq)).toEqual([3, 4]);
      expect(nextBody.latestSeq).toBe(4);

      const filterPage = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?kind=command_started`,
      });
      expect(filterPage.statusCode).toBe(200);
      expect(filterPage.json().activities).toHaveLength(0);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("404s for unknown attempt", async () => {
    const { server, db } = await buildServer();

    try {
      const response = await server.inject({ method: "GET", url: "/api/attempts/missing/activity" });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("attempt_not_found");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("rejects invalid kind filter", async () => {
    const { server, db } = await buildServer();

    try {
      const { attemptId } = seedRunningAttempt(db);
      const response = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?kind=invalid_kind`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("latest=true returns the tail rows", async () => {
    const { server, db } = await buildServer();

    try {
      const { attemptId } = seedRunningAttempt(db);
      for (let index = 0; index < 12; index += 1) {
        db.attemptActivities.appendActivity({
          executionAttemptId: attemptId,
          kind: "assistant_message",
          message: `message ${index}`,
        });
      }

      const response = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?latest=true&limit=3`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.activities.map((row: { seq: number }) => row.seq)).toEqual([10, 11, 12]);
      expect(body.latestSeq).toBe(12);
      expect(body.totalActivities).toBe(12);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("latest=true rejects combined afterSeq", async () => {
    const { server, db } = await buildServer();

    try {
      const { attemptId } = seedRunningAttempt(db);

      const response = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?latest=true&afterSeq=1`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("latest=true returns tail rows in seq coordinates after retention trim", async () => {
    const { server, db } = await buildServer();

    try {
      const { attemptId } = seedRunningAttempt(db);
      // Append 50 activities (seq 1..50), then trim down to the latest 10
      // (seq 41..50). totalActivities is 10 but the latest seq is 50, so the
      // count-based cutoff would compute afterSeq = 10 - 5 = 5 and return
      // rows 41..45 (the oldest retained) instead of 46..50 (the newest).
      for (let index = 0; index < 50; index += 1) {
        db.attemptActivities.appendActivity({
          executionAttemptId: attemptId,
          kind: "assistant_message",
          message: `message ${index}`,
        });
      }
      db.attemptActivities.trimRetention(attemptId, 10);

      const response = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?latest=true&limit=5`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.activities.map((row: { seq: number }) => row.seq)).toEqual([46, 47, 48, 49, 50]);
      expect(body.latestSeq).toBe(50);
      expect(body.totalActivities).toBe(10);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("latest=true rejects combined kind filter", async () => {
    const { server, db } = await buildServer();

    try {
      const { attemptId } = seedRunningAttempt(db);

      const response = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/activity?latest=true&kind=error`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_request");
      expect(response.json().error.message).toMatch(/latest and kind/);
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("attempt status HTTP", () => {
  test("returns a deterministic snapshot", async () => {
    const { server, db } = await buildServer();

    try {
      const { attemptId } = seedRunningAttempt(db);
      db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "assistant_message",
        message: "starting work",
      });

      const response = await server.inject({
        method: "GET",
        url: `/api/attempts/${attemptId}/status`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.snapshot.attemptId).toBe(attemptId);
      expect(["progressing", "starting"]).toContain(body.snapshot.phase);
      expect(body.snapshot.counts.activities).toBe(1);
      expect(body.snapshot.needsHuman.isNeeded).toBe(false);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("404s for unknown attempt", async () => {
    const { server, db } = await buildServer();

    try {
      const response = await server.inject({ method: "GET", url: "/api/attempts/missing/status" });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("attempt_not_found");
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("worker status HTTP", () => {
  test("returns the snapshot of the worker's current attempt", async () => {
    const { server, db } = await buildServer();

    try {
      const { workerId, attemptId } = seedRunningAttempt(db);
      db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "assistant_message",
        message: "progressing",
      });

      const response = await server.inject({
        method: "GET",
        url: `/api/workers/${workerId}/status`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.worker.id).toBe(workerId);
      expect(body.worker.currentAttemptId).toBe(attemptId);
      expect(body.snapshot.attemptId).toBe(attemptId);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns null snapshot when worker has no current attempt", async () => {
    const { server, db } = await buildServer();

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0]!;

      const response = await server.inject({
        method: "GET",
        url: `/api/workers/${worker.id}/status`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.worker.id).toBe(worker.id);
      expect(body.snapshot).toBeNull();
    } finally {
      await server.close();
      db.close();
    }
  });

  test("404s for unknown worker", async () => {
    const { server, db } = await buildServer();

    try {
      const response = await server.inject({ method: "GET", url: "/api/workers/missing/status" });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("worker_not_found");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("propagates attempt_not_found like the singular attempt endpoint", async () => {
    const { server, db } = await buildServer();

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0]!;
      db.workers.updateWorkerStatus(worker.id, "running", "missing-attempt-id");

      const response = await server.inject({
        method: "GET",
        url: `/api/workers/${worker.id}/status`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("attempt_not_found");
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("workers list snapshot", () => {
  test("includes deterministic snapshot inline for current attempts", async () => {
    const { server, db } = await buildServer();

    try {
      const { workerId, attemptId } = seedRunningAttempt(db);
      db.attemptActivities.appendActivity({
        executionAttemptId: attemptId,
        kind: "assistant_message",
        message: "working",
      });

      const response = await server.inject({ method: "GET", url: "/api/workers" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const worker = body.workers.find((entry: { id: string }) => entry.id === workerId);
      expect(worker).toBeDefined();
      expect(worker.currentAttemptStatus.attemptId).toBe(attemptId);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns null snapshot for idle workers", async () => {
    const { server, db } = await buildServer();

    try {
      db.workers.ensureWorkerSlots(1);
      const response = await server.inject({ method: "GET", url: "/api/workers" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.workers[0].currentAttemptStatus).toBeNull();
    } finally {
      await server.close();
      db.close();
    }
  });
});
