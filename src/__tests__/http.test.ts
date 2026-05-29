import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createDefaultWorkspaceConfig } from "../workspace/config.js";
import { createHttpServer } from "../http.js";
import { createSelfRebootScheduler } from "../system/reboot.js";
import type { Task } from "../domain/index.js";
import { ForemanError } from "../lib/errors.js";
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
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
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
      expect(response.json().deploymentInstructions).toEqual({ active: false, relativePath: "deployment.md" });
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

    const versionMonitor = {
      getStatus: () => ({
        commit: "0123456789abcdef0123456789abcdef01234567",
        shortCommit: "0123456",
        upstreamRef: "origin/main",
        upstreamCommit: "0123456789abcdef0123456789abcdef01234567",
        behindBy: 0,
        updateAvailable: false,
        checkedAt: "2026-03-16T00:00:00.000Z",
        errorMessage: null,
      }),
    };

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
      versionMonitor,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/status" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        integrations: {
          runners: {
            execution: {
              type: "opencode",
              model: "openai/gpt-5.5",
              status: "ok",
            },
            reviewer: {
              type: "claude",
              model: "claude-opus-4-7",
              status: "ok",
            },
          },
        },
        version: {
          shortCommit: "0123456",
          updateAvailable: false,
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

describe("HTTP rates", () => {
  test("returns the runner rate table so the UI can hydrate without duplicating it", async () => {
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
      const response = await server.inject({ method: "GET", url: "/api/rates" });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(Array.isArray(payload.rates)).toBe(true);
      expect(payload.rates.length).toBeGreaterThan(0);
      const opus = payload.rates.find(
        (rate: any) => rate.runnerName === "claude" && rate.runnerModel === "claude-opus-4-7",
      );
      expect(opus).toMatchObject({
        inputPerMtok: 15,
        outputPerMtok: 75,
        cacheReadPerMtok: 1.5,
        cacheWriteFiveMinPerMtok: 18.75,
      });
      // Lookup key intentionally has no runnerVariant — attempts persist the
      // configured effort/variant, but pricing is model-level today.
      expect(opus).not.toHaveProperty("runnerVariant");
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("HTTP usage rollup", () => {
  test("aggregates attempts in a window into per-day buckets with computed USD cost", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);

    db.taskMirror.saveTasks([sampleTask]);
    const target = db.taskMirror.getTaskTarget(sampleTask.id, "repo-a");
    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0];
    const seed = (input: {
      id: string;
      startedAt: string;
      tokens: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
    }): void => {
      const job = db.jobs.createJob({
        taskId: sampleTask.id,
        taskTargetId: target!.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: 3,
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${sampleTask.id}:${input.id}`,
        selectionReason: "test",
      });
      db.database.sqlite
        .prepare(
          `INSERT INTO execution_attempt(
            id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id,
            status, started_at, finished_at, exit_code, signal, summary, error_message, tokens_used_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          job.id,
          worker!.id,
          1,
          "claude",
          "claude-opus-4-7",
          // Use the real persisted variant ("high") so the rollup proves the
          // model-only rate key works for default-config attempts.
          "high",
          null,
          "completed",
          input.startedAt,
          input.startedAt,
          0,
          null,
          "",
          null,
          JSON.stringify(input.tokens),
        );
    };

    seed({
      id: "att-1",
      startedAt: "2026-05-20T10:00:00.000Z",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    seed({
      id: "att-2",
      startedAt: "2026-05-20T18:00:00.000Z",
      tokens: { inputTokens: 0, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    seed({
      id: "att-3",
      startedAt: "2026-05-21T09:00:00.000Z",
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0 },
    });

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: { listCandidates: vi.fn(async () => []), getTask: vi.fn(async () => sampleTask), listComments: vi.fn(async () => []) } as any,
      reviewService: { resolvePullRequest: vi.fn(async () => null) } as any,
      scheduler: {
        getStatus: () => ({ status: "running", nextScoutPollAt: null }),
        start: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(async () => undefined),
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/usage?from=2026-05-20&to=2026-05-21&groupBy=day",
      });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.fromDate).toBe("2026-05-20");
      expect(payload.toDate).toBe("2026-05-21");
      expect(payload.buckets).toHaveLength(2);
      expect(payload.buckets[0]).toMatchObject({ groupKey: "2026-05-20", attemptsCount: 2 });
      expect(payload.buckets[0].cost.totalUsd).toBeCloseTo(15 + 75);
      expect(payload.buckets[1]).toMatchObject({ groupKey: "2026-05-21", attemptsCount: 1 });
      expect(payload.buckets[1].cost.totalUsd).toBeCloseTo(1.5);
      expect(payload.totals.attemptsCount).toBe(3);
      expect(payload.totals.cost.totalUsd).toBeCloseTo(15 + 75 + 1.5);
      expect(Array.isArray(payload.rates)).toBe(true);

      const rejected = await server.inject({ method: "GET", url: "/api/usage?from=2026-5-1" });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("invalid_request");

      const rejectedGroup = await server.inject({ method: "GET", url: "/api/usage?groupBy=team" });
      expect(rejectedGroup.statusCode).toBe(400);
      expect(rejectedGroup.json().error.code).toBe("invalid_request");
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("HTTP scheduler control", () => {
  test("stops an active attempt through the scheduler", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const stopAttempt = vi.fn();

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
        stopAttempt,
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({ method: "POST", url: "/api/attempts/attempt-1/stop" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ attemptId: "attempt-1", stopRequested: true });
      expect(stopAttempt).toHaveBeenCalledWith("attempt-1");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns conflict when attempt stop is rejected", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const stopAttempt = vi.fn(() => {
      throw new ForemanError("attempt_stop_conflict", "Attempt attempt-1 is not active in this scheduler process.", 409);
    });

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
        stopAttempt,
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({ method: "POST", url: "/api/attempts/attempt-1/stop" });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: { code: "attempt_stop_conflict", message: "Attempt attempt-1 is not active in this scheduler process." },
      });
    } finally {
      await server.close();
      db.close();
    }
  });

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

describe("HTTP system reboot", () => {
  test("schedules reboot once and returns the scheduled state for repeated requests", async () => {
    const workspaceRoot = await createTempDir("foreman-http-reboot-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const spawnSidecar = vi.fn(() => true);
    const signalShutdown = vi.fn();
    const timer = vi.fn(() => ({ unref: vi.fn() })) as any;

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
      } as any,
      rebootScheduler: createSelfRebootScheduler({
        config,
        paths,
        workspace: "foo",
        logLevel: "info",
        entrypointPath: "/foreman/dist/cli.js",
        spawnSidecar,
        signalShutdown,
        setTimeout: timer,
      }),
    });

    try {
      const firstResponse = await server.inject({ method: "POST", url: "/api/system/reboot" });
      const secondResponse = await server.inject({ method: "POST", url: "/api/system/reboot" });

      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(firstResponse.json()).toEqual({ reboot: { status: "scheduled" } });
      expect(secondResponse.json()).toEqual({ reboot: { status: "scheduled" } });
      expect(spawnSidecar).toHaveBeenCalledTimes(1);
      expect(timer).toHaveBeenCalledTimes(1);
      expect(signalShutdown).not.toHaveBeenCalled();
    } finally {
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

describe("HTTP work-items rollup", () => {
  const taskA: Task = {
    ...sampleTask,
    id: "ENG-1",
    providerId: "ENG-1",
    targets: [
      { repoKey: "repo-a", branchName: "eng-1-a", position: 0 },
      { repoKey: "repo-b", branchName: "eng-1-b", position: 1 },
    ],
  };
  const taskB: Task = {
    ...sampleTask,
    id: "ENG-2",
    providerId: "ENG-2",
    targets: [{ repoKey: "repo-a", branchName: "eng-2", position: 0 }],
  };

  type SeededAttempt = {
    id: string;
    taskId: string;
    targetRepoKey: string;
    startedAt: string;
    finishedAt?: string | null;
    status: "running" | "completed" | "failed" | "blocked" | "canceled" | "timed_out";
    attemptNumber?: number;
    tokens?: Record<string, number>;
  };

  const setupWorkItemsServer = async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);

    db.taskMirror.saveTasks([taskA, taskB]);
    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0]!;

    const seedAttempt = (input: SeededAttempt): string => {
      const target = db.taskMirror.getTaskTarget(input.taskId, input.targetRepoKey);
      const job = db.jobs.createJob({
        taskId: input.taskId,
        taskTargetId: target!.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: 3,
        repoKey: input.targetRepoKey,
        baseBranch: "main",
        dedupeKey: `${input.taskId}:${input.id}`,
        selectionReason: "test",
      });
      db.database.sqlite
        .prepare(
          `INSERT INTO execution_attempt(
            id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id,
            status, started_at, finished_at, exit_code, signal, summary, error_message, tokens_used_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          job.id,
          worker.id,
          input.attemptNumber ?? 1,
          "claude",
          "claude-opus-4-7",
          "high",
          null,
          input.status,
          input.startedAt,
          input.finishedAt ?? null,
          input.status === "completed" ? 0 : null,
          null,
          "",
          null,
          input.tokens ? JSON.stringify(input.tokens) : null,
        );
      return job.id;
    };

    const seedCronAttempt = (input: { id: string; startedAt: string }): void => {
      const job = db.jobs.createCronJob({
        cronJobId: `cron-${input.id}`,
        dedupeKey: `cron:${input.id}`,
        selectionReason: "test",
      });
      db.database.sqlite
        .prepare(
          `INSERT INTO execution_attempt(
            id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id,
            status, started_at, finished_at, exit_code, signal, summary, error_message, tokens_used_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          job.id,
          worker.id,
          1,
          "claude",
          "claude-opus-4-7",
          "high",
          null,
          "completed",
          input.startedAt,
          input.startedAt,
          0,
          null,
          "",
          null,
          null,
        );
    };

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [
        { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
        { key: "repo-b", rootPath: "/repos/repo-b", defaultBranch: "main" },
      ],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => []),
        getTask: vi.fn(async () => taskA),
        listComments: vi.fn(async () => []),
      } as any,
      reviewService: { resolvePullRequest: vi.fn(async () => null) } as any,
      scheduler: {
        getStatus: () => ({ status: "running", nextScoutPollAt: null }),
        start: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(async () => undefined),
        triggerManualScout: vi.fn(),
      } as any,
    });

    return { db, server, seedAttempt, seedCronAttempt };
  };

  test("rolls up multiple attempts on one ticket into a single bucket with summed tokens and cost", async () => {
    const { db, server, seedAttempt } = await setupWorkItemsServer();

    seedAttempt({
      id: "att-1",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      finishedAt: "2026-05-20T10:30:00.000Z",
      status: "completed",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    seedAttempt({
      id: "att-2",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T18:00:00.000Z",
      finishedAt: "2026-05-20T18:30:00.000Z",
      status: "completed",
      attemptNumber: 2,
      tokens: { inputTokens: 0, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20",
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.buckets).toHaveLength(1);
      expect(payload.buckets[0]).toMatchObject({
        taskId: "ENG-1",
        attemptsCount: 2,
        effectiveStatus: "completed",
      });
      expect(payload.buckets[0].cost.totalUsd).toBeCloseTo(15 + 75);
      expect(payload.buckets[0].firstSeenInWindow).toBe("2026-05-20T10:00:00.000Z");
      expect(payload.totals.attemptsCount).toBe(2);
      expect(Array.isArray(payload.rates)).toBe(true);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns one sorted bucket per ticket when multiple tickets run in the window", async () => {
    const { db, server, seedAttempt } = await setupWorkItemsServer();

    seedAttempt({
      id: "att-1",
      taskId: "ENG-2",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      finishedAt: "2026-05-20T10:30:00.000Z",
      status: "completed",
    });
    seedAttempt({
      id: "att-2",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T11:00:00.000Z",
      finishedAt: "2026-05-20T11:30:00.000Z",
      status: "completed",
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20",
      });
      const payload = response.json();
      expect(payload.buckets.map((bucket: { taskId: string }) => bucket.taskId)).toEqual([
        "ENG-1",
        "ENG-2",
      ]);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("excludes cron attempts that have no taskId via the IS NOT NULL join filter", async () => {
    const { db, server, seedAttempt, seedCronAttempt } = await setupWorkItemsServer();

    seedAttempt({
      id: "att-task",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      finishedAt: "2026-05-20T10:30:00.000Z",
      status: "completed",
    });
    seedCronAttempt({ id: "att-cron", startedAt: "2026-05-20T11:00:00.000Z" });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20",
      });
      const payload = response.json();
      expect(payload.buckets).toHaveLength(1);
      expect(payload.buckets[0].taskId).toBe("ENG-1");
      expect(payload.buckets[0].attemptsCount).toBe(1);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("captures per-target latest status for a multi-target ticket", async () => {
    const { db, server, seedAttempt } = await setupWorkItemsServer();

    seedAttempt({
      id: "att-a",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      finishedAt: "2026-05-20T10:30:00.000Z",
      status: "completed",
    });
    seedAttempt({
      id: "att-b",
      taskId: "ENG-1",
      targetRepoKey: "repo-b",
      startedAt: "2026-05-20T11:00:00.000Z",
      finishedAt: "2026-05-20T11:30:00.000Z",
      status: "failed",
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20",
      });
      const payload = response.json();
      expect(payload.buckets).toHaveLength(1);
      expect(payload.buckets[0].targets).toEqual(["repo-a", "repo-b"]);
      expect(payload.buckets[0].perTargetLatestStatus).toEqual([
        { target: "repo-a", status: "completed" },
        { target: "repo-b", status: "failed" },
      ]);
      expect(payload.buckets[0].effectiveStatus).toBe("failed");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("rejects malformed from/to and invalid status values", async () => {
    const { db, server } = await setupWorkItemsServer();
    try {
      const invalidFrom = await server.inject({ method: "GET", url: "/api/work-items?from=2026-5-1" });
      expect(invalidFrom.statusCode).toBe(400);
      expect(invalidFrom.json().error.code).toBe("invalid_request");

      const invalidStatus = await server.inject({ method: "GET", url: "/api/work-items?status=unknown" });
      expect(invalidStatus.statusCode).toBe(400);
      expect(invalidStatus.json().error.code).toBe("invalid_request");

      // Well-formed dates but from > to — resolveUsageRange throws and the
      // endpoint must map that to 400 invalid_request, not bubble a 500.
      const invertedRange = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-26&to=2026-05-20",
      });
      expect(invertedRange.statusCode).toBe(400);
      expect(invertedRange.json().error.code).toBe("invalid_request");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("filters by the bucket's effective status (running over latest started)", async () => {
    const { db, server, seedAttempt } = await setupWorkItemsServer();

    seedAttempt({
      id: "att-running",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      status: "running",
    });
    seedAttempt({
      id: "att-completed",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T11:00:00.000Z",
      finishedAt: "2026-05-20T11:30:00.000Z",
      status: "completed",
      attemptNumber: 2,
    });
    seedAttempt({
      id: "att-other",
      taskId: "ENG-2",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T12:00:00.000Z",
      finishedAt: "2026-05-20T12:30:00.000Z",
      status: "completed",
    });

    try {
      const runningResponse = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20&status=running",
      });
      const runningPayload = runningResponse.json();
      expect(runningPayload.buckets).toHaveLength(1);
      expect(runningPayload.buckets[0].taskId).toBe("ENG-1");
      expect(runningPayload.buckets[0].effectiveStatus).toBe("running");

      const completedResponse = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20&status=completed",
      });
      const completedPayload = completedResponse.json();
      expect(completedPayload.buckets).toHaveLength(1);
      expect(completedPayload.buckets[0].taskId).toBe("ENG-2");
    } finally {
      await server.close();
      db.close();
    }
  });

  test("totals stay aligned with returned buckets when status filter is applied", async () => {
    const { db, server, seedAttempt } = await setupWorkItemsServer();

    seedAttempt({
      id: "att-running",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      status: "running",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    seedAttempt({
      id: "att-other",
      taskId: "ENG-2",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T11:00:00.000Z",
      finishedAt: "2026-05-20T11:30:00.000Z",
      status: "completed",
      tokens: { inputTokens: 0, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20&status=running",
      });
      const payload = response.json();
      const bucketSum = payload.buckets.reduce(
        (acc: number, bucket: { attemptsCount: number }) => acc + bucket.attemptsCount,
        0,
      );
      expect(payload.totals.attemptsCount).toBe(bucketSum);
      expect(payload.totals.attemptsCount).toBe(1);
      // ENG-1 contributed 1M input tokens; ENG-2 (completed, excluded by the
      // filter) must not leak its 1M output tokens into the totals.
      expect(payload.totals.tokens.outputTokens).toBe(0);
      expect(payload.totals.tokens.inputTokens).toBe(1_000_000);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("totals stay aligned with returned buckets when search filter is applied", async () => {
    const { db, server, seedAttempt } = await setupWorkItemsServer();

    seedAttempt({
      id: "att-eng-1",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      finishedAt: "2026-05-20T10:30:00.000Z",
      status: "completed",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    seedAttempt({
      id: "att-eng-2",
      taskId: "ENG-2",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T11:00:00.000Z",
      finishedAt: "2026-05-20T11:30:00.000Z",
      status: "completed",
      tokens: { inputTokens: 0, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20&search=ENG-1",
      });
      const payload = response.json();
      const bucketSum = payload.buckets.reduce(
        (acc: number, bucket: { attemptsCount: number }) => acc + bucket.attemptsCount,
        0,
      );
      expect(payload.buckets).toHaveLength(1);
      expect(payload.buckets[0].taskId).toBe("ENG-1");
      expect(payload.totals.attemptsCount).toBe(bucketSum);
      expect(payload.totals.attemptsCount).toBe(1);
      // ENG-2 (excluded by search) must not leak its output tokens.
      expect(payload.totals.tokens.outputTokens).toBe(0);
      expect(payload.totals.tokens.inputTokens).toBe(1_000_000);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("applies status and search filters together (AND, not OR)", async () => {
    const { db, server, seedAttempt } = await setupWorkItemsServer();

    // ENG-1 is running (matches status, matches search).
    seedAttempt({
      id: "att-1-running",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T10:00:00.000Z",
      status: "running",
      tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    // ENG-2 is running (matches status, does not match search).
    seedAttempt({
      id: "att-2-running",
      taskId: "ENG-2",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T11:00:00.000Z",
      status: "running",
      tokens: { inputTokens: 2_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    // ENG-1 also has a completed attempt — but the bucket's effective status
    // stays "running" so it still matches.
    seedAttempt({
      id: "att-1-completed",
      taskId: "ENG-1",
      targetRepoKey: "repo-a",
      startedAt: "2026-05-20T12:00:00.000Z",
      finishedAt: "2026-05-20T12:30:00.000Z",
      status: "completed",
      attemptNumber: 2,
      tokens: { inputTokens: 0, outputTokens: 500_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20&status=running&search=ENG-1",
      });
      const payload = response.json();
      // Only ENG-1 matches BOTH predicates. An OR refactor would also
      // return ENG-2 (matches status) and an AND→OR regression on either
      // predicate would also surface a different bucket count.
      expect(payload.buckets.map((bucket: { taskId: string }) => bucket.taskId)).toEqual(["ENG-1"]);
      expect(payload.buckets[0].attemptsCount).toBe(2);
      const bucketSum = payload.buckets.reduce(
        (acc: number, bucket: { attemptsCount: number }) => acc + bucket.attemptsCount,
        0,
      );
      expect(payload.totals.attemptsCount).toBe(bucketSum);
      // ENG-2's 2M input tokens must not leak into totals.
      expect(payload.totals.tokens.inputTokens).toBe(1_000_000);
      expect(payload.totals.tokens.outputTokens).toBe(500_000);
    } finally {
      await server.close();
      db.close();
    }
  });

  test("returns empty buckets but still reports rates when the window has no attempts", async () => {
    const { db, server } = await setupWorkItemsServer();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/work-items?from=2026-05-20&to=2026-05-20",
      });
      const payload = response.json();
      expect(payload.buckets).toEqual([]);
      expect(payload.totals.attemptsCount).toBe(0);
      expect(payload.totals.cost.totalUsd).toBe(0);
      expect(Array.isArray(payload.rates)).toBe(true);
      expect(payload.rates.length).toBeGreaterThan(0);
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe("HTTP attempts taskId filter", () => {
  test("returns only attempts whose job has the requested task_id", async () => {
    const workspaceRoot = await createTempDir("foreman-http-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const db = await createMigratedDb(paths.dbPath, projectRoot);

    const taskA: Task = {
      ...sampleTask,
      id: "ENG-1",
      providerId: "ENG-1",
    };
    const taskB: Task = {
      ...sampleTask,
      id: "ENG-2",
      providerId: "ENG-2",
      targets: [{ repoKey: "repo-a", branchName: "eng-2", position: 0 }],
    };
    db.taskMirror.saveTasks([taskA, taskB]);
    db.workers.ensureWorkerSlots(1);
    const worker = db.workers.listWorkers()[0]!;

    const seedAttempt = (input: { id: string; taskId: string; startedAt: string }) => {
      const target = db.taskMirror.getTaskTarget(input.taskId, "repo-a")!;
      const job = db.jobs.createJob({
        taskId: input.taskId,
        taskTargetId: target.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: 3,
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${input.taskId}:${input.id}`,
        selectionReason: "test",
      });
      db.database.sqlite
        .prepare(
          `INSERT INTO execution_attempt(
            id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, runner_session_id,
            status, started_at, finished_at, exit_code, signal, summary, error_message, tokens_used_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, 0, NULL, '', NULL, NULL)`,
        )
        .run(
          input.id,
          job.id,
          worker.id,
          1,
          "claude",
          "claude-opus-4-7",
          "high",
          null,
          input.startedAt,
          input.startedAt,
        );
    };

    seedAttempt({ id: "att-1", taskId: "ENG-1", startedAt: "2026-05-20T10:00:00.000Z" });
    seedAttempt({ id: "att-2", taskId: "ENG-2", startedAt: "2026-05-20T11:00:00.000Z" });
    seedAttempt({ id: "att-3", taskId: "ENG-1", startedAt: "2026-05-20T12:00:00.000Z" });

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem: {
        listCandidates: vi.fn(async () => []),
        getTask: vi.fn(async () => taskA),
        listComments: vi.fn(async () => []),
      } as any,
      reviewService: { resolvePullRequest: vi.fn(async () => null) } as any,
      scheduler: {
        getStatus: () => ({ status: "running", nextScoutPollAt: null }),
        start: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(async () => undefined),
        triggerManualScout: vi.fn(),
      } as any,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/attempts?taskId=ENG-1" });
      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.attempts.map((attempt: { id: string }) => attempt.id).sort()).toEqual([
        "att-1",
        "att-3",
      ]);
      expect(payload.attempts.every((attempt: { taskId: string }) => attempt.taskId === "ENG-1")).toBe(true);
    } finally {
      await server.close();
      db.close();
    }
  });
});
