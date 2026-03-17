import { promises as fs } from "node:fs";
import path from "node:path";

import Fastify from "fastify";

import type { WorkspaceConfig, WorkspacePaths } from "./config.js";
import type { RepoRef, TaskState } from "./domain/index.js";
import { ForemanError, isForemanError } from "./lib/errors.js";
import type { SchedulerService } from "./orchestration/index.js";
import type { ForemanRepos } from "./repos/index.js";
import type { TaskSystem } from "./tasking/index.js";

type HttpServerDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  repos: RepoRef[];
  foremanRepos: ForemanRepos;
  taskSystem: TaskSystem;
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

export const createHttpServer = (deps: HttpServerDeps) => {
  const server = Fastify({ logger: false });

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
      lastScoutRunAt: deps.foremanRepos.scoutRuns.listScoutRuns(1)[0]?.startedAt ?? null,
      nextScoutPollAt: deps.scheduler.getStatus().nextScoutPollAt,
    },
    integrations: {
      taskSystem: { type: deps.config.taskSystem.type, status: "ok" },
      reviewSystem: { type: deps.config.reviewSystem.type, status: "ok" },
      runner: { type: deps.config.runner.type, status: "ok" },
    },
    repos: {
      count: deps.repos.length,
      keys: deps.repos.map((repo) => repo.key),
    },
  }));

  server.get("/api/tasks", async (request) => {
    const query = request.query as { state?: string; search?: string; limit?: string };
    const state = parseEnumQuery("state", query.state, taskStates);
    const limit = parsePositiveIntegerQuery("limit", query.limit);
    const tasks = (await deps.taskSystem.listCandidates())
      .filter((task) => (state ? task.state === state : true))
      .filter((task) => {
        if (!query.search) {
          return true;
        }
        const search = query.search.toLowerCase();
        return task.id.toLowerCase().includes(search) || task.title.toLowerCase().includes(search);
      })
      .slice(0, limit ?? 100)
      .map((task) => ({
        id: task.id,
        provider: task.provider,
        title: task.title,
        state: task.state,
        providerState: task.providerState,
        priority: task.priority,
        repo: task.repo,
        updatedAt: task.updatedAt,
        url: task.url,
      }));
    return { tasks };
  });

  server.get("/api/tasks/:taskId", async (request) => {
    const params = request.params as { taskId: string };
    const [task, comments] = await Promise.all([
      deps.taskSystem.getTask(params.taskId),
      deps.taskSystem.listComments(params.taskId),
    ]);
    return { task, comments };
  });

  server.get("/api/queue", async () => ({
    jobs: deps.foremanRepos.jobs.listQueue().map((job) => ({
      id: job.id,
      taskId: job.taskId,
      action: job.action,
      status: job.status,
      priorityRank: job.priorityRank,
      repoKey: job.repoKey,
      createdAt: job.createdAt,
    })),
  }));

  server.get("/api/jobs/:jobId", async (request) => {
    const params = request.params as { jobId: string };
    const job = deps.foremanRepos.jobs.getJob(params.jobId);
    const latestAttempt = deps.foremanRepos.attempts.latestAttemptForJob(job.id);
    const artifacts = deps.foremanRepos.artifacts.listArtifacts("job", job.id);
    return {
      job: {
        id: job.id,
        taskId: job.taskId,
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
    const query = request.query as { status?: string; jobId?: string; limit?: string };
    const filters: { status?: "running" | "completed" | "failed" | "blocked" | "canceled" | "timed_out"; jobId?: string; limit?: number } = {};
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
    return {
      attempts: deps.foremanRepos.attempts.listAttempts(filters),
    };
  });

  server.get("/api/attempts/:attemptId", async (request) => {
    const params = request.params as { attemptId: string };
    return {
      attempt: deps.foremanRepos.attempts.getAttempt(params.attemptId),
      events: deps.foremanRepos.attempts.listAttemptEvents(params.attemptId),
      artifacts: deps.foremanRepos.artifacts.listArtifacts("execution_attempt", params.attemptId),
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
    const logPath = attemptLogPath(deps.paths, params.attemptId);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let offset = 0;
    const interval = setInterval(async () => {
      try {
        const contents = await fs.readFile(logPath, "utf8");
        const nextChunk = contents.slice(offset);
        if (nextChunk) {
          offset = contents.length;
          for (const line of nextChunk.split(/\r?\n/).filter(Boolean)) {
            writeSseEvent(reply, "log", line);
          }
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
    workers: deps.foremanRepos.workers.listWorkers().map((worker) => ({
      id: worker.id,
      slot: worker.slot,
      status: worker.status,
      currentAttemptId: worker.currentAttemptId,
      lastHeartbeatAt: worker.lastHeartbeatAt,
    })),
  }));

  server.get("/api/workers/:workerId/logs/stream", async (request, reply) => {
    const params = request.params as { workerId: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let activeAttemptId: string | null = null;
    let offset = 0;

    const interval = setInterval(async () => {
      const worker = deps.foremanRepos.workers.listWorkers().find((item) => item.id === params.workerId);
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
          for (const line of nextChunk.split(/\r?\n/).filter(Boolean)) {
            writeSseEvent(reply, "log", line);
          }
        }
      } catch {
        writeSseEvent(reply, "ping", "{}");
      }
    }, 1000);

    request.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  server.get("/api/history", async () => ({ history: deps.foremanRepos.history.listHistory() }));
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
      learnings: deps.foremanRepos.learnings.listLearnings(filters),
    };
  });
  server.get("/api/scout/runs", async () => ({ runs: deps.foremanRepos.scoutRuns.listScoutRuns() }));

  server.post("/api/scheduler/start", async () => {
    await deps.scheduler.start();
    return { scheduler: { status: deps.scheduler.getStatus().status } };
  });

  server.post("/api/scheduler/pause", async () => {
    deps.scheduler.pause();
    return { scheduler: { status: deps.scheduler.getStatus().status } };
  });

  server.post("/api/scheduler/stop", async () => {
    await deps.scheduler.stop();
    return { scheduler: { status: deps.scheduler.getStatus().status } };
  });

  server.post("/api/scout/run", async () => {
    deps.scheduler.triggerManualScout();
    return { scout: { status: "scheduled", trigger: "manual" } };
  });

  return server;
};
