import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import type { JobRecord } from "./repos/index.js";
import type { RepoRef, ResolvedPullRequest, Task, TaskState, TaskTarget, TaskTargetStatus } from "./domain/index.js";
import { ForemanError, isForemanError } from "./lib/errors.js";
import type { SchedulerService } from "./orchestration/index.js";
import type { ForemanRepos } from "./repos/index.js";
import type { ReviewService } from "./review/index.js";
import type { TaskSystem } from "./tasking/index.js";
import type { WorkspaceConfig } from "./workspace/config.js";
import type { WorkspacePaths } from "./workspace/workspace-paths.js";

type HttpServerDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  repoRefs: RepoRef[];
  repos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  scheduler: SchedulerService;
};

const errorShape = (error: unknown): { error: { code: string; message: string } } => {
  if (isForemanError(error)) {
    return { error: { code: error.code, message: error.message } };
  }

  return { error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } };
};

const attemptLogPath = (paths: WorkspacePaths, attemptId: string): string =>
  path.join(paths.workspaceRoot, "logs", "attempts", `${attemptId}.log`);

const writeSseEvent = (reply: { raw: NodeJS.WritableStream }, event: string, data: string): void => {
  reply.raw.write(`event: ${event}\n`);
  for (const line of data.split(/\r?\n/)) {
    reply.raw.write(`data: ${line}\n`);
  }
  reply.raw.write("\n");
};

const parsePositiveIntegerQuery = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new ForemanError("invalid_request", `Query parameter ${name} must be a positive integer.`, 400);
  }

  const parsed = Number.parseInt(value, 10);
  return parsed;
};

const parseNonNegativeIntegerQuery = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new ForemanError("invalid_request", `Query parameter ${name} must be a non-negative integer.`, 400);
  }

  const parsed = Number.parseInt(value, 10);
  return parsed;
};

const parseEnumQuery = <T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!allowed.includes(value as T)) {
    throw new ForemanError("invalid_request", `Query parameter ${name} must be one of: ${allowed.join(", ")}.`, 400);
  }

  return value as T;
};

const taskStates = ["ready", "in_progress", "in_review", "done", "canceled"] as const satisfies readonly TaskState[];
const attemptStatuses = ["running", "completed", "failed", "blocked", "canceled", "timed_out"] as const;
const activeJobStatuses = new Set<JobRecord["status"]>(["queued", "leased", "running"]);
type TargetProgressState = "pending" | "active" | "in_review" | "merged" | "completed" | "retryable";

type BuiltTaskTarget = {
  id: string;
  taskId: string;
  repoKey: string;
  branchName: string;
  status: TaskTargetStatus;
  progressState: TargetProgressState;
  review: {
    pullRequestUrl: string;
    pullRequestNumber: number;
    state: "open" | "closed" | "merged";
    isDraft: boolean;
    baseBranch: string;
    headBranch: string;
  } | null;
  latestJob: {
    id: string;
    action: JobRecord["action"];
    status: JobRecord["status"];
    createdAt: string;
    finishedAt: string | null;
  } | null;
  latestAttempt: {
    id: string;
    status: "running" | "completed" | "failed" | "blocked" | "canceled" | "timed_out";
    startedAt: string;
    finishedAt: string | null;
  } | null;
};

const dependenciesSatisfiedForTask = (task: Task, tasksById: ReadonlyMap<string, Task>): boolean => {
  if (task.dependencies.taskIds.length === 0) {
    return true;
  }

  return task.dependencies.taskIds.every((dependencyTaskId) => {
    const dependencyTask = tasksById.get(dependencyTaskId);
    if (!dependencyTask) {
      return false;
    }

    if (dependencyTaskId === task.dependencies.baseTaskId) {
      return dependencyTask.state === "in_review" || dependencyTask.state === "done";
    }

    return dependencyTask.state === "done";
  });
};

const deriveTaskTargetStatus = (input: {
  task: Task;
  latestJob: JobRecord | null;
  progressState: TargetProgressState;
  dependenciesSatisfied: boolean;
}): TaskTargetStatus => {
  if (input.task.state === "done" || input.task.state === "canceled") {
    return input.task.state;
  }

  if (!input.dependenciesSatisfied) {
    return "blocked";
  }

  switch (input.progressState) {
    case "active":
      return input.latestJob?.action === "review" ? "in_review" : "in_progress";
    case "in_review":
      return "in_review";
    case "merged":
    case "completed":
      return "done";
    case "retryable":
      return "in_review";
    case "pending":
      return input.task.state === "in_review" ? "ready" : input.task.state;
  }

  return input.task.state;
};

export const createHttpServer = (deps: HttpServerDeps) => {
  const server = Fastify({ logger: false });
  const uiRoot = path.join(deps.paths.projectRoot, "ui", "dist");
  const hasUiBuild = existsSync(uiRoot);
  const getAllMirroredTasks = (): Task[] => deps.repos.taskMirror.getTasks();

  const persistedOrTaskTargets = (task: Task): TaskTarget[] => {
    const persistedTargets = deps.repos.taskMirror.getTargetsForTask(task.id);
    if (persistedTargets.length > 0) {
      return persistedTargets;
    }
    return task.targets.map((target, position) => ({
      id: `unpersisted:${task.id}:${target.repoKey}`,
      taskId: task.id,
      repoKey: target.repoKey,
      branchName: target.branchName,
      position: target.position ?? position,
    }));
  };

  const buildTaskTargets = async (
    task: Task,
    tasksById: ReadonlyMap<string, Task>,
    cache = new Map<string, Promise<BuiltTaskTarget>>(),
  ): Promise<BuiltTaskTarget[]> => {
    const buildTarget = async (targetTask: Task, target: TaskTarget): Promise<BuiltTaskTarget> => {
      let promise = cache.get(target.id);
      if (!promise) {
        promise = (async () => {
          const repo = deps.repoRefs.find((item) => item.key === target.repoKey);
          const pullRequest = repo ? await deps.reviewService.resolvePullRequest(targetTask, repo, target) : null;
          const latestJob = deps.repos.jobs.latestJobForTaskTarget(target.id);
          const latestAttempt = deps.repos.attempts.latestAttemptForTaskTarget(target.id);
          const missingCrossTaskDependency = targetTask.dependencies.taskIds.some((dependencyTaskId) => {
            const dependencyTask = tasksById.get(dependencyTaskId) ?? deps.repos.taskMirror.getTask(dependencyTaskId);
            if (!dependencyTask) {
              return true;
            }

            return deps.repos.taskMirror.getTaskTarget(dependencyTaskId, target.repoKey) === null;
          });
          const dependencyRecords = deps.repos.taskMirror
            .getTargetDependenciesForTask(targetTask.id)
            .filter((dependency) => dependency.taskTargetId === target.id);
          const dependencyStatuses = await Promise.all(
            dependencyRecords.map(async (dependency) => {
              const dependencyTarget = deps.repos.taskMirror.getTaskTargetById(dependency.dependsOnTaskTargetId);
              if (!dependencyTarget) {
                return false;
              }

              const dependencyTask =
                tasksById.get(dependencyTarget.taskId) ??
                deps.repos.taskMirror.getTask(dependencyTarget.taskId) ??
                (await deps.taskSystem.getTask(dependencyTarget.taskId));
              const builtDependency = await buildTarget(dependencyTask, dependencyTarget);
              return (
                builtDependency.progressState === "in_review" ||
                builtDependency.progressState === "merged" ||
                builtDependency.progressState === "completed"
              );
            }),
          );
          const dependenciesSatisfied = !missingCrossTaskDependency && dependencyStatuses.every(Boolean);
          const progressState: TargetProgressState = latestJob && activeJobStatuses.has(latestJob.status)
            ? "active"
            : pullRequest?.state === "open"
              ? "in_review"
              : pullRequest?.state === "merged"
                ? "merged"
                : pullRequest?.state === "closed"
                  ? "retryable"
                  : latestJob &&
                      (latestJob.action === "execution" || latestJob.action === "retry") &&
                      latestJob.status === "completed" &&
                      latestAttempt?.status === "completed"
                    ? "completed"
                    : "pending";

          return {
            id: target.id,
            taskId: target.taskId,
            repoKey: target.repoKey,
            branchName: target.branchName,
            status: deriveTaskTargetStatus({ task: targetTask, latestJob, progressState, dependenciesSatisfied }),
            progressState,
            review:
              pullRequest === null
                ? null
                : {
                    pullRequestUrl: pullRequest.pullRequestUrl,
                    pullRequestNumber: pullRequest.pullRequestNumber,
                    state: pullRequest.state,
                    isDraft: pullRequest.isDraft,
                    baseBranch: pullRequest.baseBranch,
                    headBranch: pullRequest.headBranch,
                  },
            latestJob:
              latestJob === null
                ? null
                : {
                    id: latestJob.id,
                    action: latestJob.action,
                    status: latestJob.status,
                    createdAt: latestJob.createdAt,
                    finishedAt: latestJob.finishedAt,
                  },
            latestAttempt:
              latestAttempt === null
                ? null
                : {
                    id: latestAttempt.id,
                    status: latestAttempt.status,
                    startedAt: latestAttempt.startedAt,
                    finishedAt: latestAttempt.finishedAt,
                  },
          };
        })();
        cache.set(target.id, promise);
      }

      return promise;
    };

    return Promise.all(persistedOrTaskTargets(task).map((target) => buildTarget(task, target)));
  };

  const serializeTask = async (
    task: Task,
    tasksById: ReadonlyMap<string, Task>,
    cache = new Map<string, Promise<BuiltTaskTarget>>(),
  ) => {
    const targets = await buildTaskTargets(task, tasksById, cache);

    return {
      id: task.id,
      provider: task.provider,
      providerId: task.providerId,
      title: task.title,
      description: task.description,
      state: task.state,
      providerState: task.providerState,
      priority: task.priority,
      labels: task.labels,
      assignee: task.assignee,
      dependencies: task.dependencies,
      pullRequests: task.pullRequests,
      updatedAt: task.updatedAt,
      url: task.url,
      targets,
    };
  };

  server.setErrorHandler((error, _request, reply) => {
    const body = errorShape(error);
    const statusCode = isForemanError(error) ? error.statusCode : 500;
    void reply.status(statusCode).send(body);
  });

  server.get("/api/status", async () => ({
    workspace: {
      name: deps.config.workspace.name,
      root: deps.paths.workspaceRoot,
    },
    scheduler: {
      status: deps.scheduler.getStatus().status,
      workerConcurrency: deps.config.scheduler.workerConcurrency,
      scoutPollIntervalSeconds: deps.config.scheduler.scoutPollIntervalSeconds,
      lastScoutRunAt: deps.repos.scoutRuns.listScoutRuns(1)[0]?.startedAt ?? null,
      nextScoutPollAt: deps.scheduler.getStatus().nextScoutPollAt,
    },
    integrations: {
      taskSystem: { type: deps.config.taskSystem.type, status: "ok" },
      reviewSystem: { type: deps.config.reviewSystem.type, status: "ok" },
      runner: { type: deps.config.runner.type, status: "ok" },
    },
    repos: {
      count: deps.repoRefs.length,
      keys: deps.repoRefs.map((repo) => repo.key),
    },
  }));

  server.get("/api/tasks", async (request) => {
    const query = request.query as { state?: string; search?: string; limit?: string };
    const state = parseEnumQuery("state", query.state, taskStates);
    const limit = parsePositiveIntegerQuery("limit", query.limit);
    const taskQuery = {
      ...(state ? { state } : {}),
      ...(query.search ? { search: query.search } : {}),
      limit: limit ?? 100,
    };
    const tasksById = new Map(getAllMirroredTasks().map((task) => [task.id, task]));
    const tasks = await Promise.all(
      deps.repos.taskMirror
        .getTasks(taskQuery)
        .map((task) => serializeTask(task, tasksById)),
    );
    return { tasks };
  });

  server.get("/api/tasks/:taskId", async (request) => {
    const params = request.params as { taskId: string };
    const commentsPromise = deps.taskSystem.listComments(params.taskId);
    const mirroredTask = deps.repos.taskMirror.getTask(params.taskId);
    const task = mirroredTask ?? (await deps.taskSystem.getTask(params.taskId));
    const comments = await commentsPromise;
    const tasksById = new Map(getAllMirroredTasks().map((candidateTask) => [candidateTask.id, candidateTask]));
    tasksById.set(task.id, task);
    return { task: await serializeTask(task, tasksById), comments };
  });

  server.get("/api/queue", async () => ({
    jobs: deps.repos.jobs.listQueue().map((job) => ({
      id: job.id,
      taskId: job.taskId,
      taskTargetId: job.taskTargetId,
      action: job.action,
      status: job.status,
      priorityRank: job.priorityRank,
      repoKey: job.repoKey,
      createdAt: job.createdAt,
    })),
  }));

  server.get("/api/jobs/:jobId", async (request) => {
    const params = request.params as { jobId: string };
    const job = deps.repos.jobs.getJob(params.jobId);
    const latestAttempt = deps.repos.attempts.latestAttemptForJob(job.id);
    const artifacts = deps.repos.artifacts.listArtifacts("job", job.id);
    return {
      job: {
        id: job.id,
        taskId: job.taskId,
        taskTargetId: job.taskTargetId,
        action: job.action,
        status: job.status,
        priorityRank: job.priorityRank,
        repoKey: job.repoKey,
        baseBranch: job.baseBranch,
        selectionReason: job.selectionReason,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
      latestAttempt,
      artifacts,
    };
  });

  server.get("/api/attempts", async (request) => {
    const query = request.query as { status?: string; jobId?: string; limit?: string; offset?: string };
    const filters: { status?: "running" | "completed" | "failed" | "blocked" | "canceled" | "timed_out"; jobId?: string; limit?: number; offset?: number } = {};
    const status = parseEnumQuery("status", query.status, attemptStatuses);
    if (status !== undefined) {
      filters.status = status;
    }
    if (query.jobId) {
      filters.jobId = query.jobId;
    }
    const limit = parsePositiveIntegerQuery("limit", query.limit);
    if (limit !== undefined) {
      filters.limit = limit;
    }
    const offset = parseNonNegativeIntegerQuery("offset", query.offset);
    if (offset !== undefined) {
      filters.offset = offset;
    }
    return {
      attempts: deps.repos.attempts.listAttempts(filters),
    };
  });

  server.get("/api/attempts/:attemptId", async (request) => {
    const params = request.params as { attemptId: string };
    return {
      attempt: deps.repos.attempts.getAttempt(params.attemptId),
      events: deps.repos.attempts.listAttemptEvents(params.attemptId),
      artifacts: deps.repos.artifacts.listArtifacts("execution_attempt", params.attemptId),
    };
  });

  server.get("/api/attempts/:attemptId/logs", async (request, reply) => {
    const params = request.params as { attemptId: string };
    const logPath = attemptLogPath(deps.paths, params.attemptId);
    reply.type("text/plain");
    try {
      return await fs.readFile(logPath, "utf8");
    } catch {
      throw new ForemanError("attempt_log_not_found", `Attempt log not found: ${params.attemptId}`, 404);
    }
  });

  server.get("/api/attempts/:attemptId/logs/stream", async (request, reply) => {
    const params = request.params as { attemptId: string };
    const query = request.query as { offset?: string };
    const logPath = attemptLogPath(deps.paths, params.attemptId);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let offset = parseNonNegativeIntegerQuery("offset", query.offset) ?? 0;
    const interval = setInterval(async () => {
      try {
        const contents = await fs.readFile(logPath, "utf8");
        const nextChunk = contents.slice(offset);
        if (nextChunk) {
          offset = contents.length;
          writeSseEvent(reply, "log", nextChunk);
        } else {
          writeSseEvent(reply, "ping", "{}");
        }
      } catch {
        writeSseEvent(reply, "ping", "{}");
      }
    }, 1000);

    request.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  server.get("/api/workers", async () => ({
    workers: deps.repos.workers.listWorkers().map((worker) => {
      const currentAttempt = worker.currentAttemptId
        ? (() => {
            try {
              return deps.repos.attempts.getAttempt(worker.currentAttemptId);
            } catch {
              return null;
            }
          })()
        : null;

      const currentJob = currentAttempt
        ? (() => {
            try {
              return deps.repos.jobs.getJob(currentAttempt.jobId);
            } catch {
              return null;
            }
          })()
        : null;

      return {
        id: worker.id,
        slot: worker.slot,
        status: worker.status,
        currentAttemptId: worker.currentAttemptId,
        lastHeartbeatAt: worker.lastHeartbeatAt,
        currentAttempt:
          currentAttempt === null
            ? null
            : {
                id: currentAttempt.id,
                jobId: currentAttempt.jobId,
                status: currentAttempt.status,
                startedAt: currentAttempt.startedAt,
              },
        currentJob:
          currentJob === null
            ? null
            : {
                id: currentJob.id,
                taskId: currentJob.taskId,
                taskTargetId: currentJob.taskTargetId,
                action: currentJob.action,
                repoKey: currentJob.repoKey,
                status: currentJob.status,
              },
      };
    }),
  }));

  server.get("/api/workers/:workerId/logs/stream", async (request, reply) => {
    const params = request.params as { workerId: string };
    const query = request.query as { offset?: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let activeAttemptId: string | null = null;
    let offset = parseNonNegativeIntegerQuery("offset", query.offset) ?? 0;

    const interval = setInterval(async () => {
      const worker = deps.repos.workers.listWorkers().find((item) => item.id === params.workerId);
      if (!worker) {
        writeSseEvent(reply, "ping", "{}");
        return;
      }

      if (worker.currentAttemptId !== activeAttemptId) {
        activeAttemptId = worker.currentAttemptId;
        offset = 0;
        writeSseEvent(reply, "attempt_changed", JSON.stringify({ attemptId: activeAttemptId }));
      }

      if (!activeAttemptId) {
        writeSseEvent(reply, "ping", "{}");
        return;
      }

      try {
        const contents = await fs.readFile(attemptLogPath(deps.paths, activeAttemptId), "utf8");
        const nextChunk = contents.slice(offset);
        if (nextChunk) {
          offset = contents.length;
          writeSseEvent(reply, "log", nextChunk);
        }
      } catch {
        writeSseEvent(reply, "ping", "{}");
      }
    }, 1000);

    request.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  server.get("/api/history", async (request) => {
    const query = request.query as { stage?: string; repo?: string; search?: string; limit?: string; offset?: string };
    const filters: { stage?: string; repo?: string; search?: string; limit?: number; offset?: number } = {};
    if (query.stage) {
      filters.stage = query.stage;
    }
    if (query.repo) {
      filters.repo = query.repo;
    }
    if (query.search) {
      filters.search = query.search;
    }
    const limit = parsePositiveIntegerQuery("limit", query.limit);
    if (limit !== undefined) {
      filters.limit = limit;
    }
    const offset = parseNonNegativeIntegerQuery("offset", query.offset);
    if (offset !== undefined) {
      filters.offset = offset;
    }
    return { history: deps.repos.history.listHistory(filters) };
  });
  server.get("/api/learnings", async (request) => {
    const query = request.query as { search?: string; repo?: string; limit?: string; offset?: string };
    const filters: { search?: string; repo?: string; limit?: number; offset?: number } = {};
    if (query.search) {
      filters.search = query.search;
    }
    if (query.repo) {
      filters.repo = query.repo;
    }
    const limit = parsePositiveIntegerQuery("limit", query.limit);
    if (limit !== undefined) {
      filters.limit = limit;
    }
    const offset = parseNonNegativeIntegerQuery("offset", query.offset);
    if (offset !== undefined) {
      filters.offset = offset;
    }
    return {
      learnings: deps.repos.learnings.listLearnings(filters),
    };
  });
  server.get("/api/scout/runs", async () => ({ runs: deps.repos.scoutRuns.listScoutRuns() }));

  server.post("/api/scheduler/start", async () => {
    await deps.scheduler.start();
    return { scheduler: { status: deps.scheduler.getStatus().status } };
  });

  server.post("/api/scheduler/pause", async () => {
    deps.scheduler.pause();
    return { scheduler: { status: deps.scheduler.getStatus().status } };
  });

  server.post("/api/scheduler/stop", async () => {
    void deps.scheduler.stop().catch((error) => {
      server.log.error(error, "scheduler stop failed");
    });
    return { scheduler: { status: deps.scheduler.getStatus().status } };
  });

  server.post("/api/scout/run", async () => {
    deps.scheduler.triggerManualScout();
    return { scout: { status: "scheduled", trigger: "manual" } };
  });

  if (hasUiBuild) {
    void server.register(fastifyStatic, { root: uiRoot, prefix: "/" });

    server.setNotFoundHandler((request, reply) => {
      const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
      if (request.method === "GET" && !request.url.startsWith("/api/") && acceptsHtml) {
        return fs.readFile(path.join(uiRoot, "index.html"), "utf8").then((html) => reply.type("text/html").send(html));
      }

      void reply.status(404).send({ error: { code: "not_found", message: `Route not found: ${request.method} ${request.url}` } });
    });
  }

  return server;
};
