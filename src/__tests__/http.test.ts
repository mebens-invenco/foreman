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
  repo: "repo-a",
  branchName: "task-0001",
  dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
  artifacts: [],
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
};

const secondaryTask: Task = {
  ...sampleTask,
  id: "TASK-0002",
  providerId: "TASK-0002",
  title: "Other task",
  state: "in_review",
  repo: null,
  branchName: null,
  updatedAt: "2026-03-13T12:00:00Z",
};

describe("HTTP query validation", () => {
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

      const invalidAttemptStatus = await server.inject({ method: "GET", url: "/api/attempts?status=nope" });
      expect(invalidAttemptStatus.statusCode).toBe(400);
      expect(invalidAttemptStatus.json().error.code).toBe("invalid_request");

      const invalidAttemptOffset = await server.inject({ method: "GET", url: "/api/attempts?offset=-1" });
      expect(invalidAttemptOffset.statusCode).toBe(400);
      expect(invalidAttemptOffset.json()).toEqual({
        error: { code: "invalid_request", message: "Query parameter offset must be a non-negative integer." },
      });

      const invalidHistoryLimit = await server.inject({ method: "GET", url: "/api/history?limit=0" });
      expect(invalidHistoryLimit.statusCode).toBe(400);
      expect(invalidHistoryLimit.json()).toEqual({
        error: { code: "invalid_request", message: "Query parameter limit must be a positive integer." },
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
      artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo-a/pull/7" }],
    };

    const taskSystem = {
      listCandidates: vi.fn(async () => [taskWithPr, secondaryTask]),
      getTask: vi.fn(async () => taskWithPr),
      listComments: vi.fn(async () => []),
    } as any;

    db.taskMirror.saveTasks([taskWithPr, secondaryTask]);

    const server = createHttpServer({
      config: createDefaultWorkspaceConfig("foo", "file"),
      paths,
      repoRefs: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      repos: db,
      taskSystem,
      reviewService: {
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
      const listResponse = await server.inject({ method: "GET", url: "/api/tasks" });
      expect(listResponse.statusCode).toBe(200);
      expect(db.taskMirror.getTask(taskWithPr.id)).toMatchObject({ id: taskWithPr.id, repo: "repo-a", branchName: "task-0001" });
      expect(taskSystem.listCandidates).not.toHaveBeenCalled();
      expect(listResponse.json()).toMatchObject({
        tasks: [
          {
            id: "TASK-0001",
            repo: "repo-a",
            reviewUrl: "https://github.com/acme/repo-a/pull/7",
            targets: [
              {
                repoKey: "repo-a",
                branchName: "task-0001",
                status: "in_review",
                review: {
                  pullRequestUrl: "https://github.com/acme/repo-a/pull/7",
                  pullRequestNumber: 7,
                  state: "open",
                  isDraft: true,
                  baseBranch: "main",
                  headBranch: "task-0001",
                },
              },
            ],
          },
          expect.objectContaining({
            id: secondaryTask.id,
            repo: null,
            reviewUrl: null,
            targets: [],
          }),
        ],
      });

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
      repo: null,
      branchName: "eng-4774",
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
