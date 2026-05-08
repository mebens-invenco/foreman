import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createHttpServer } from "../http.js";
import type { Task } from "../domain/index.js";
import { createMigratedDb, createTempDir, createWorkspacePaths, testProjectRoot } from "../test-support/helpers.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const sampleTask: Task = {
  id: "TASK-0001",
  provider: "file",
  providerId: "TASK-0001",
  title: "Task",
  description: "",
  state: "ready",
  providerState: "ready",
  priority: "normal",
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: "repo-a", branchName: "task-0001", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  pullRequests: [],
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
};

const secondaryTask: Task = {
  ...sampleTask,
  id: "TASK-0002",
  providerId: "TASK-0002",
  title: "Other task",
  state: "in_review",
  targets: [],
  targetDependencies: [],
  updatedAt: "2026-03-13T12:00:00Z",
};

describe("HTTP query validation", () => {
  test("patches live workspace settings and persists workspace config", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    await fs.writeFile(paths.configPath, "");
    const server = createHttpServer({
      config,
      paths,
      repoRefs: [],
      repos: db,
      taskSystem: {} as any,
      reviewService: {} as any,
      scheduler: {
        getStatus: () => ({ status: "running", nextScoutPollAt: null }),
        start: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(async () => undefined),
        triggerManualScout: vi.fn(),
        syncConfigUpdate: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: {
          workspace: { agentPrefix: "[bot] " },
          cron: { enabled: true, jobsDir: "automation" },
          agentTaskCreation: { enabled: true },
          scheduler: { workerConcurrency: 2 },
          runner: { execution: { model: "openai/gpt-5.5" } },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().config.cron).toEqual({ enabled: true, jobsDir: "automation" });
      expect(response.json().config.agentTaskCreation).toEqual({ enabled: true });
      expect(response.json().config.scheduler.workerConcurrency).toBe(2);
      expect(response.json().config.runner.execution.model).toBe("openai/gpt-5.5");
      expect(response.json().config.workspace.agentPrefix).toBe("[bot] ");
      expect(config.cron.enabled).toBe(true);
      expect(config.scheduler.workerConcurrency).toBe(2);
      const persisted = await fs.readFile(paths.configPath, "utf8");
      expect(persisted).toContain("jobsDir: automation");
      expect(persisted).toContain("agentPrefix");
      expect(persisted).toContain("[bot] ");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("rejects read-only live settings patches", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [],
      repos: db,
      taskSystem: {} as any,
      reviewService: {} as any,
      scheduler: {
        getStatus: () => ({ status: "running", nextScoutPollAt: null }),
        start: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(async () => undefined),
        triggerManualScout: vi.fn(),
        syncConfigUpdate: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { http: { port: 9999 } },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("http is read-only");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns invalid_request for malformed query params", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => [sampleTask]),
        getTask: vi.fn(async () => sampleTask),
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
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const invalidTaskLimit = await server.inject({ method: "GET", url: "/api/tasks?limit=abc" });
      expect(invalidTaskLimit.statusCode).toBe(400);
      expect(invalidTaskLimit.json()).toEqual({
        error: { code: "invalid_request", message: "Query parameter limit must be a positive integer." },
      });

      const invalidTaskState = await server.inject({ method: "GET", url: "/api/tasks?state=waiting" });
      expect(invalidTaskState.statusCode).toBe(400);
      expect(invalidTaskState.json().error.code).toBe("invalid_request");

      const invalidRefreshReview = await server.inject({ method: "GET", url: "/api/tasks?refreshReview=1" });
      expect(invalidRefreshReview.statusCode).toBe(400);
      expect(invalidRefreshReview.json()).toEqual({
        error: { code: "invalid_request", message: "Query parameter refreshReview must be true or false." },
      });

      const invalidAttemptStatus = await server.inject({ method: "GET", url: "/api/attempts?status=nope" });
      expect(invalidAttemptStatus.statusCode).toBe(400);
      expect(invalidAttemptStatus.json().error.code).toBe("invalid_request");

      const invalidAttemptOffset = await server.inject({ method: "GET", url: "/api/attempts?offset=-1" });
      expect(invalidAttemptOffset.statusCode).toBe(400);
      expect(invalidAttemptOffset.json()).toEqual({
        error: { code: "invalid_request", message: "Query parameter offset must be a non-negative integer." },
      });

      const invalidOffset = await server.inject({ method: "GET", url: "/api/learnings?offset=-1" });
      expect(invalidOffset.statusCode).toBe(400);
      expect(invalidOffset.json()).toEqual({
        error: { code: "invalid_request", message: "Query parameter offset must be a non-negative integer." },
      });
    } finally {
      await server.close();
      db.close();
    }
  });

  test("serves mirrored tasks and returns target projections for task APIs", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const taskWithPr: Task = {
      ...sampleTask,
      state: "in_review",
      providerState: "in_review",
      pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo-a/pull/7", source: "provider" }],
    };

    const taskSystem = {
      listCandidates: vi.fn(async () => [taskWithPr, secondaryTask]),
      getTask: vi.fn(async () => taskWithPr),
      listComments: vi.fn(async () => []),
    } as any;

    db.taskMirror.saveTasks([taskWithPr, secondaryTask]);

    const reviewService = {
      resolvePullRequest: vi.fn(async (task: Task) =>
        task.id === taskWithPr.id
          ? {
              pullRequestUrl: "https://github.com/acme/repo-a/pull/7",
              pullRequestNumber: 7,
              state: "open",
              isDraft: true,
              headBranch: "task-0001",
              baseBranch: "main",
            }
          : null,
      ),
    };

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem,
      reviewService: reviewService as any,
      scheduler: {
        getStatus: () => ({ status: "running", nextScoutPollAt: null }),
        start: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(async () => undefined),
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const listResponse = await server.inject({ method: "GET", url: "/api/tasks" });
      expect(listResponse.statusCode).toBe(200);
      expect(db.taskMirror.getTask(taskWithPr.id)).toMatchObject({
        id: taskWithPr.id,
        targets: [{ repoKey: "repo-a", branchName: "task-0001", position: 0 }],
      });
      expect(taskSystem.listCandidates).not.toHaveBeenCalled();
      expect(listResponse.json()).toMatchObject({
        tasks: [
          {
            id: "TASK-0001",
            targets: [
              {
                repoKey: "repo-a",
                branchName: "task-0001",
                status: "in_review",
                review: {
                  pullRequestUrl: "https://github.com/acme/repo-a/pull/7",
                  pullRequestNumber: 7,
                  state: "open",
                  isDraft: false,
                  baseBranch: "main",
                  headBranch: "task-0001",
                },
              },
            ],
          },
          expect.objectContaining({
            id: secondaryTask.id,
            targets: [],
          }),
        ],
      });
      expect(reviewService.resolvePullRequest).not.toHaveBeenCalled();

      const filteredResponse = await server.inject({ method: "GET", url: "/api/tasks?state=in_review&search=other" });
      expect(filteredResponse.statusCode).toBe(200);
      expect(filteredResponse.json()).toEqual({
        tasks: [
          expect.objectContaining({
            id: secondaryTask.id,
          }),
        ],
      });

      const detailResponse = await server.inject({ method: "GET", url: "/api/tasks/TASK-0001" });
      expect(detailResponse.statusCode).toBe(200);
      expect(db.taskMirror.getTargetsForTask(taskWithPr.id)).toHaveLength(1);
      expect(taskSystem.getTask).not.toHaveBeenCalled();
      expect(detailResponse.json().task.targets).toMatchObject([
        {
          repoKey: "repo-a",
          branchName: "task-0001",
          status: "in_review",
        },
      ]);
      expect(reviewService.resolvePullRequest).not.toHaveBeenCalled();

      const refreshedResponse = await server.inject({ method: "GET", url: "/api/tasks?refreshReview=true" });
      expect(refreshedResponse.statusCode).toBe(200);
      expect(reviewService.resolvePullRequest).toHaveBeenCalledTimes(1);
      expect(refreshedResponse.json().tasks[0].targets[0].review).toMatchObject({
        pullRequestUrl: "https://github.com/acme/repo-a/pull/7",
        pullRequestNumber: 7,
        state: "open",
        isDraft: true,
        baseBranch: "main",
        headBranch: "task-0001",
      });
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns per-target blocked state for multi-target tasks", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const multiTargetTask: Task = {
      ...sampleTask,
      id: "ENG-4774",
      providerId: "ENG-4774",
      title: "Multi-target task",
      targets: [
        { repoKey: "repo-a", branchName: "eng-4774", position: 0 },
        { repoKey: "repo-b", branchName: "eng-4774", position: 1 },
      ],
      targetDependencies: [{ taskTargetRepoKey: "repo-b", dependsOnRepoKey: "repo-a", position: 0 }],
    };

    db.taskMirror.saveTasks([multiTargetTask]);

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [
        { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        { key: "repo-b", rootPath: "/repos/repo-b", defaultBranch: "main" },
      ],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => [multiTargetTask]),
        getTask: vi.fn(async () => multiTargetTask),
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
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/tasks" });
      expect(response.statusCode).toBe(200);
      expect(response.json().tasks).toMatchObject([
        {
          id: multiTargetTask.id,
          targets: [
            { repoKey: "repo-a", status: "ready" },
            { repoKey: "repo-b", status: "blocked" },
          ],
        },
      ]);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("reports execution and reviewer runners separately in status", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");

    const server = createHttpServer({
      config,
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => [sampleTask]),
        getTask: vi.fn(async () => sampleTask),
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
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        integrations: {
          runners: {
            execution: {
              type: "opencode",
              model: "openai/gpt-5.4",
              status: "ok",
            },
            reviewer: {
              type: "claude",
              model: "claude-opus-4-6",
              status: "ok",
            },
          },
        },
      });
    } finally {
      await server.close();
      db.close();
    }
  });

  test("serializes cron attempts and active worker jobs", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0];
    const job = db.jobs.createCronJob({
      cronJobId: "cron/check.md",
      dedupeKey: "cron:cron/check.md",
      selectionReason: "test cron",
    });
    const attempt = db.attempts.createAttemptWithLeases({
      jobId: job.id,
      workerId: worker!.id,
      runnerName: "opencode",
      runnerModel: "openai/gpt-5.4",
      runnerVariant: "standard",
      expiresAt: "2026-03-16T00:10:00Z",
      leases: [{ resourceType: "cron", resourceKey: job.dedupeKey }],
    });
    db.workers.updateWorkerStatus(worker!.id, "running", attempt!.id);

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [],
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
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const attemptsResponse = await server.inject({ method: "GET", url: "/api/attempts" });
      expect(attemptsResponse.statusCode).toBe(200);
      expect(attemptsResponse.json().attempts[0]).toMatchObject({
        id: attempt!.id,
        jobKind: "cron",
        taskId: null,
        target: null,
        cronJobId: "cron/check.md",
        stage: "cron",
      });

      const workersResponse = await server.inject({ method: "GET", url: "/api/workers" });
      expect(workersResponse.statusCode).toBe(200);
      expect(workersResponse.json().workers[0].currentJob).toMatchObject({
        jobKind: "cron",
        cronJobId: "cron/check.md",
        taskId: null,
        repoKey: null,
      });
    } finally {
      await server.close();
      db.close();
    }
  });

  test("joins task URL into attempt and worker serializers", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);

    const linkedTask: Task = {
      ...sampleTask,
      url: "https://linear.app/invenco/issue/TASK-0001",
    };
    db.taskMirror.saveTasks([linkedTask]);
    const target = db.taskMirror.getTaskTarget(linkedTask.id, "repo-a");

    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0];
    const job = db.jobs.createJob({
      taskId: linkedTask.id,
      taskTargetId: target!.id,
      taskProvider: "file",
      action: "execution",
      priorityRank: 3,
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${linkedTask.id}:execution`,
      selectionReason: "test",
    });
    const attempt = db.attempts.createAttemptWithLeases({
      jobId: job.id,
      workerId: worker!.id,
      runnerName: "opencode",
      runnerModel: "openai/gpt-5.4",
      runnerVariant: "standard",
      expiresAt: "2026-03-16T00:10:00Z",
      leases: [{ resourceType: "task", resourceKey: linkedTask.id }],
    });
    db.workers.updateWorkerStatus(worker!.id, "running", attempt!.id);

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => [linkedTask]),
        getTask: vi.fn(async () => linkedTask),
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
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const attemptsResponse = await server.inject({ method: "GET", url: "/api/attempts" });
      expect(attemptsResponse.statusCode).toBe(200);
      expect(attemptsResponse.json().attempts[0]).toMatchObject({
        id: attempt!.id,
        taskId: linkedTask.id,
        taskUrl: "https://linear.app/invenco/issue/TASK-0001",
      });

      const detailResponse = await server.inject({
        method: "GET",
        url: `/api/attempts/${encodeURIComponent(attempt!.id)}`,
      });
      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json().attempt).toMatchObject({
        id: attempt!.id,
        taskUrl: "https://linear.app/invenco/issue/TASK-0001",
      });

      const workersResponse = await server.inject({ method: "GET", url: "/api/workers" });
      expect(workersResponse.statusCode).toBe(200);
      expect(workersResponse.json().workers[0].currentJob).toMatchObject({
        taskId: linkedTask.id,
        taskUrl: "https://linear.app/invenco/issue/TASK-0001",
      });
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns null taskUrl when the mirrored task has no provider URL", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);

    db.taskMirror.saveTasks([sampleTask]);
    const target = db.taskMirror.getTaskTarget(sampleTask.id, "repo-a");
    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0];
    const job = db.jobs.createJob({
      taskId: sampleTask.id,
      taskTargetId: target!.id,
      taskProvider: "file",
      action: "execution",
      priorityRank: 3,
      repoKey: "repo-a",
      baseBranch: "main",
      dedupeKey: `${sampleTask.id}:execution`,
      selectionReason: "test",
    });
    const attempt = db.attempts.createAttemptWithLeases({
      jobId: job.id,
      workerId: worker!.id,
      runnerName: "opencode",
      runnerModel: "openai/gpt-5.4",
      runnerVariant: "standard",
      expiresAt: "2026-03-16T00:10:00Z",
      leases: [{ resourceType: "task", resourceKey: sampleTask.id }],
    });
    db.workers.updateWorkerStatus(worker!.id, "running", attempt!.id);

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => [sampleTask]),
        getTask: vi.fn(async () => sampleTask),
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
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const attemptsResponse = await server.inject({ method: "GET", url: "/api/attempts" });
      expect(attemptsResponse.statusCode).toBe(200);
      expect(attemptsResponse.json().attempts[0]).toMatchObject({
        id: attempt!.id,
        taskUrl: null,
      });

      const workersResponse = await server.inject({ method: "GET", url: "/api/workers" });
      expect(workersResponse.statusCode).toBe(200);
      expect(workersResponse.json().workers[0].currentJob).toMatchObject({
        taskUrl: null,
      });
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("HTTP scheduler control", () => {
  test("returns stopping immediately while scheduler shutdown continues in background", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);

    let schedulerStatus = "running";
    let releaseStop = () => undefined;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          schedulerStatus = "stopping";
          releaseStop = () => {
            schedulerStatus = "stopped";
            resolve();
          };
        }),
    );

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => [sampleTask]),
        getTask: vi.fn(async () => sampleTask),
        listComments: vi.fn(async () => []),
      } as any,
      reviewService: {
        resolvePullRequest: vi.fn(async () => null),
      } as any,
      scheduler: {
        getStatus: () => ({ status: schedulerStatus, nextScoutPollAt: null }),
        start: vi.fn(),
        pause: vi.fn(),
        stop,
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({ method: "POST", url: "/api/scheduler/stop" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ scheduler: { status: "stopping" } });
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      releaseStop();
      await server.close();
      db.close();
    }
  });
});

describe("HTTP artifact content", () => {
  const createArtifactServer = async () => {
    const workspaceRoot = await createTempDir("foreman-http-artifact-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => [sampleTask]),
        getTask: vi.fn(async () => sampleTask),
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
        triggerManualScout: vi.fn(),
      } as any,
    });

    return { db, paths, server };
  };

  test("serves artifact content by artifact id", async () => {
    const { db, paths, server } = await createArtifactServer();

    try {
      await fs.mkdir(paths.artifactsDir, { recursive: true });
      await fs.writeFile(path.join(paths.artifactsDir, "attempt-result.json"), '{"ok":true}', "utf8");
      db.artifacts.createArtifact({
        ownerType: "execution_attempt",
        ownerId: "attempt-1",
        artifactType: "parsed_result",
        relativePath: "artifacts/attempt-result.json",
        mediaType: "application/json",
        sizeBytes: 11,
      });
      const artifact = db.artifacts.listArtifacts("execution_attempt", "attempt-1")[0];
      expect(artifact).toBeDefined();

      const response = await server.inject({ method: "GET", url: `/api/artifacts/${artifact!.id}/content` });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"ok":true}');
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns not found for missing artifacts and missing files", async () => {
    const { db, server } = await createArtifactServer();

    try {
      const missingArtifactResponse = await server.inject({ method: "GET", url: "/api/artifacts/missing/content" });
      expect(missingArtifactResponse.statusCode).toBe(404);
      expect(missingArtifactResponse.json().error.code).toBe("artifact_not_found");

      db.artifacts.createArtifact({
        ownerType: "execution_attempt",
        ownerId: "attempt-1",
        artifactType: "rendered_prompt",
        relativePath: "artifacts/missing-prompt.md",
        mediaType: "text/markdown",
        sizeBytes: 42,
      });
      const artifact = db.artifacts.listArtifacts("execution_attempt", "attempt-1")[0];
      expect(artifact).toBeDefined();

      const missingFileResponse = await server.inject({ method: "GET", url: `/api/artifacts/${artifact!.id}/content` });
      expect(missingFileResponse.statusCode).toBe(404);
      expect(missingFileResponse.json().error.code).toBe("artifact_file_not_found");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("rejects artifact paths outside the workspace root", async () => {
    const { db, server } = await createArtifactServer();

    try {
      db.artifacts.createArtifact({
        ownerType: "execution_attempt",
        ownerId: "attempt-1",
        artifactType: "rendered_prompt",
        relativePath: "../outside.md",
        mediaType: "text/markdown",
        sizeBytes: 1,
      });
      const artifact = db.artifacts.listArtifacts("execution_attempt", "attempt-1")[0];
      expect(artifact).toBeDefined();

      const response = await server.inject({ method: "GET", url: `/api/artifacts/${artifact!.id}/content` });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_artifact_path");
    } finally {
      await server.close();
      db.close();
    }
  });
});
