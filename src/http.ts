import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { listRunnerRates } from "./execution/cost/rates.js";
import {
  isUsageGroupBy,
  rollupUsage,
  usageGroupByValues,
  type UsageGroupBy,
} from "./execution/cost/usage-rollup.js";
import { isIsoDate, resolveUsageRange } from "./execution/cost/usage-range.js";
import { rollupWorkItems, sumWorkItemTotals } from "./execution/cost/work-item-rollup.js";
import { unavailableForemanVersionStatus, type ForemanVersionStatus } from "./foreman-version.js";
import type { AttemptRecord, JobRecord } from "./repos/index.js";
import type {
  RepoRef,
  ResolvedPullRequest,
  Task,
  TaskPullRequest,
  TaskState,
  TaskTarget,
  TaskTargetStatus,
} from "./domain/index.js";
import { ForemanError, isForemanError } from "./lib/errors.js";
import type { SchedulerService } from "./orchestration/index.js";
import type { ForemanRepos } from "./repos/index.js";
import type { ReviewService } from "./review/index.js";
import type { RebootScheduler } from "./system/reboot.js";
import type { TaskSystem } from "./tasking/index.js";
import { stringifyWorkspaceConfig, workspaceConfigSchema, type WorkspaceConfig } from "./workspace/config.js";
import { resolveDeploymentInstructions } from "./workspace/deployment.js";
import type { WorkspacePaths } from "./workspace/workspace-paths.js";

type HttpServerDeps = {
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  repoRefs: RepoRef[];
  repos: ForemanRepos;
  taskSystem: TaskSystem;
  reviewService: ReviewService;
  scheduler: SchedulerService;
  versionMonitor?: { getStatus(): ForemanVersionStatus };
  // Optional so injected/test servers can expose the API surface without wiring process-level reboot side effects.
  rebootScheduler?: RebootScheduler;
};

const errorShape = (error: unknown): { error: { code: string; message: string } } => {
  if (isForemanError(error)) {
    return { error: { code: error.code, message: error.message } };
  }

  return { error: { code: "internal_error", message: error instanceof Error ? error.message : String(error) } };
};

const attemptLogPath = (paths: WorkspacePaths, attemptId: string): string =>
  path.join(paths.workspaceRoot, "logs", "attempts", `${attemptId}.log`);

const attemptWorktreePath = (paths: WorkspacePaths, attempt: AttemptRecord): string | null => {
  if (!attempt.taskId || !attempt.target) {
    return null;
  }

  return path.join(paths.worktreesDir, attempt.target, attempt.taskId);
};

const attemptApiRecord = (
  paths: WorkspacePaths,
  attempt: AttemptRecord,
  taskUrl: string | null,
): AttemptRecord & { worktreePath: string | null; taskUrl: string | null } => ({
  ...attempt,
  worktreePath: attemptWorktreePath(paths, attempt),
  taskUrl,
});

const resolveTaskUrl = (deps: HttpServerDeps, taskId: string | null): string | null => {
  if (!taskId) {
    return null;
  }

  try {
    return deps.repos.taskMirror.getTask(taskId)?.url ?? null;
  } catch {
    return null;
  }
};

const resolveArtifactContentPath = async (paths: WorkspacePaths, relativePath: string): Promise<string> => {
  const workspaceRoot = path.resolve(paths.workspaceRoot);
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  const isWithinWorkspace = resolvedPath === workspaceRoot || resolvedPath.startsWith(`${workspaceRoot}${path.sep}`);
  if (!isWithinWorkspace) {
    throw new ForemanError("invalid_artifact_path", "Artifact path must resolve inside the workspace root.", 400);
  }

  let realWorkspaceRoot = workspaceRoot;
  try {
    realWorkspaceRoot = await fs.realpath(workspaceRoot);
  } catch {
    // Fall back to the resolved workspace root for tests or partially-created workspaces.
  }

  let realResolvedPath: string;
  try {
    realResolvedPath = await fs.realpath(resolvedPath);
  } catch {
    throw new ForemanError("artifact_file_not_found", "Artifact file not found.", 404);
  }

  const isRealPathWithinWorkspace =
    realResolvedPath === realWorkspaceRoot || realResolvedPath.startsWith(`${realWorkspaceRoot}${path.sep}`);
  if (!isRealPathWithinWorkspace) {
    throw new ForemanError("invalid_artifact_path", "Artifact path must resolve inside the workspace root.", 400);
  }

  return realResolvedPath;
};

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

const parseBooleanQuery = (name: string, value: string | undefined): boolean => {
  if (value === undefined) {
    return false;
  }

  if (value !== "true" && value !== "false") {
    throw new ForemanError("invalid_request", `Query parameter ${name} must be true or false.`, 400);
  }

  return value === "true";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const deepMerge = (target: unknown, patch: unknown): unknown => {
  if (!isRecord(target) || !isRecord(patch)) {
    return patch;
  }

  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
};

const cloneConfig = (config: WorkspaceConfig): WorkspaceConfig => JSON.parse(JSON.stringify(config)) as WorkspaceConfig;

const assignWorkspaceConfig = (target: WorkspaceConfig, source: WorkspaceConfig): void => {
  const mutableTarget = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutableTarget)) {
    delete mutableTarget[key];
  }
  Object.assign(target, source);
};

const assertEditableSettingsPatch = (patch: Record<string, unknown>): void => {
  const readonlyTopLevel = ["version", "repos", "reviewSystem", "http"];
  for (const key of readonlyTopLevel) {
    if (key in patch) {
      throw new ForemanError("invalid_request", `${key} is read-only while Foreman is running.`, 400);
    }
  }

  if (isRecord(patch.taskSystem) && "type" in patch.taskSystem) {
    throw new ForemanError("invalid_request", "taskSystem.type is read-only while Foreman is running.", 400);
  }
};

const applySettingsPatch = (config: WorkspaceConfig, patch: Record<string, unknown>): WorkspaceConfig => {
  assertEditableSettingsPatch(patch);
  const merged = deepMerge(cloneConfig(config), patch);
  const parsed = workspaceConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
    throw new ForemanError("invalid_request", message, 400);
  }
  return parsed.data;
};

const settingsResponse = async (config: WorkspaceConfig, paths: WorkspacePaths) => {
  const deploymentInstructions = await resolveDeploymentInstructions(paths);
  return {
    config,
    deploymentInstructions: {
      active: deploymentInstructions !== null,
      relativePath: deploymentInstructions?.relativePath ?? "deployment.md",
    },
  };
};

const taskStates = ["ready", "in_progress", "in_review", "deployable", "done", "canceled"] as const satisfies readonly TaskState[];
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

const pullRequestNumberFromUrl = (url: string): number => {
  const match = /\/pull\/(\d+)(?:\D|$)/.exec(url);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
};

const mirroredPullRequestForTarget = (task: Task, target: TaskTarget): TaskPullRequest | null =>
  task.pullRequests.find((pullRequest) => pullRequest.repoKey === target.repoKey) ?? null;

const mirroredReviewForTarget = (
  task: Task,
  target: TaskTarget,
  repo?: RepoRef,
): ResolvedPullRequest | null => {
  const pullRequest = mirroredPullRequestForTarget(task, target);
  if (!pullRequest) {
    return null;
  }

  return {
    pullRequestUrl: pullRequest.url,
    pullRequestNumber: pullRequestNumberFromUrl(pullRequest.url),
    state: "open",
    isDraft: false,
    headBranch: target.branchName,
    baseBranch: repo?.defaultBranch ?? "",
  };
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
        return input.latestJob?.action === "review" || input.latestJob?.action === "reviewer" ? "in_review" : "in_progress";
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
    refreshReview: boolean,
    cache = new Map<string, Promise<BuiltTaskTarget>>(),
  ): Promise<BuiltTaskTarget[]> => {
    const buildTarget = async (targetTask: Task, target: TaskTarget): Promise<BuiltTaskTarget> => {
      let promise = cache.get(target.id);
      if (!promise) {
        promise = (async () => {
          const repo = deps.repoRefs.find((item) => item.key === target.repoKey);
          const mirroredPullRequest = mirroredReviewForTarget(targetTask, target, repo);
          const pullRequest = refreshReview && repo
            ? (await deps.reviewService.resolvePullRequest(targetTask, repo, target)) ?? mirroredPullRequest
            : mirroredPullRequest;
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
    refreshReview: boolean,
    cache = new Map<string, Promise<BuiltTaskTarget>>(),
  ) => {
    const targets = await buildTaskTargets(task, tasksById, refreshReview, cache);

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
    cron: deps.config.cron,
    agentTaskCreation: deps.config.agentTaskCreation,
    integrations: {
      taskSystem: { type: deps.config.taskSystem.type, status: "ok" },
      reviewSystem: { type: deps.config.reviewSystem.type, status: "ok" },
      runners: {
        execution: {
          type: deps.config.runner.execution.type,
          model: deps.config.runner.execution.model,
          status: "ok",
        },
        reviewer: {
          type: deps.config.runner.reviewer.type,
          model: deps.config.runner.reviewer.model,
          status: "ok",
        },
      },
    },
    repos: {
      count: deps.repoRefs.length,
      keys: deps.repoRefs.map((repo) => repo.key),
    },
    version: deps.versionMonitor?.getStatus() ?? unavailableForemanVersionStatus(),
  }));

  server.get("/api/tasks", async (request) => {
    const query = request.query as { state?: string; search?: string; limit?: string; refreshReview?: string };
    const state = parseEnumQuery("state", query.state, taskStates);
    const limit = parsePositiveIntegerQuery("limit", query.limit);
    const refreshReview = parseBooleanQuery("refreshReview", query.refreshReview);
    const taskQuery = {
      ...(state ? { state } : {}),
      ...(query.search ? { search: query.search } : {}),
      limit: limit ?? 100,
    };
    const tasksById = new Map(getAllMirroredTasks().map((task) => [task.id, task]));
    const tasks = await Promise.all(
      deps.repos.taskMirror
        .getTasks(taskQuery)
        .map((task) => serializeTask(task, tasksById, refreshReview)),
    );
    return { tasks };
  });

  server.get("/api/tasks/:taskId", async (request) => {
    const params = request.params as { taskId: string };
    const query = request.query as { refreshReview?: string };
    const refreshReview = parseBooleanQuery("refreshReview", query.refreshReview);
    const commentsPromise = deps.taskSystem.listComments(params.taskId);
    const mirroredTask = deps.repos.taskMirror.getTask(params.taskId);
    const task = mirroredTask ?? (await deps.taskSystem.getTask(params.taskId));
    const comments = await commentsPromise;
    const tasksById = new Map(getAllMirroredTasks().map((candidateTask) => [candidateTask.id, candidateTask]));
    tasksById.set(task.id, task);
    return { task: await serializeTask(task, tasksById, refreshReview), comments };
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
    const query = request.query as {
      status?: string;
      jobId?: string;
      taskId?: string;
      limit?: string;
      offset?: string;
    };
    const filters: {
      status?: "running" | "completed" | "failed" | "blocked" | "canceled" | "timed_out";
      jobId?: string;
      taskId?: string;
      limit?: number;
      offset?: number;
    } = {};
    const status = parseEnumQuery("status", query.status, attemptStatuses);
    if (status !== undefined) {
      filters.status = status;
    }
    if (query.jobId) {
      filters.jobId = query.jobId;
    }
    if (query.taskId) {
      filters.taskId = query.taskId;
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
      attempts: deps.repos.attempts
        .listAttempts(filters)
        .map((attempt) => attemptApiRecord(deps.paths, attempt, resolveTaskUrl(deps, attempt.taskId))),
    };
  });

  server.get("/api/attempts/:attemptId", async (request) => {
    const params = request.params as { attemptId: string };
    const attempt = deps.repos.attempts.getAttempt(params.attemptId);
    return {
      attempt: attemptApiRecord(deps.paths, attempt, resolveTaskUrl(deps, attempt.taskId)),
      events: deps.repos.attempts.listAttemptEvents(params.attemptId),
      artifacts: deps.repos.artifacts.listArtifacts("execution_attempt", params.attemptId),
    };
  });

  server.post("/api/attempts/:attemptId/stop", async (request) => {
    const params = request.params as { attemptId: string };
    deps.scheduler.stopAttempt(params.attemptId);
    return { attemptId: params.attemptId, stopRequested: true };
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

  server.get("/api/artifacts/:artifactId/content", async (request, reply) => {
    const params = request.params as { artifactId: string };
    const artifact = deps.repos.artifacts.getArtifact(params.artifactId);
    const artifactPath = await resolveArtifactContentPath(deps.paths, artifact.relativePath);
    reply.type(artifact.mediaType || "text/plain");
    return fs.readFile(artifactPath, "utf8");
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
                jobKind: currentJob.jobKind,
                taskId: currentJob.taskId,
                taskUrl: resolveTaskUrl(deps, currentJob.taskId),
                taskTargetId: currentJob.taskTargetId,
                cronJobId: currentJob.cronJobId,
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

  server.get("/api/rates", async () => ({ rates: listRunnerRates() }));

  server.get("/api/usage", async (request) => {
    const query = request.query as { from?: string; to?: string; groupBy?: string };
    if (query.from !== undefined && !isIsoDate(query.from)) {
      throw new ForemanError("invalid_request", "Query parameter from must be YYYY-MM-DD.", 400);
    }
    if (query.to !== undefined && !isIsoDate(query.to)) {
      throw new ForemanError("invalid_request", "Query parameter to must be YYYY-MM-DD.", 400);
    }
    const groupBy: UsageGroupBy = query.groupBy === undefined
      ? "day"
      : isUsageGroupBy(query.groupBy)
        ? query.groupBy
        : (() => {
            throw new ForemanError(
              "invalid_request",
              `Query parameter groupBy must be one of: ${usageGroupByValues.join(", ")}.`,
              400,
            );
          })();

    let range;
    try {
      range = resolveUsageRange({
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
      });
    } catch (error) {
      throw new ForemanError(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid usage range.",
        400,
      );
    }

    const rows = deps.repos.attempts.listUsageRows({
      fromInclusive: range.fromInclusive,
      toExclusive: range.toExclusive,
    });
    const rollup = rollupUsage({
      rows,
      groupBy,
      fromInclusive: range.fromInclusive,
      toExclusive: range.toExclusive,
    });

    return {
      groupBy: rollup.groupBy,
      fromDate: range.fromDate,
      toDate: range.toDate,
      fromInclusive: rollup.fromInclusive,
      toExclusive: rollup.toExclusive,
      buckets: rollup.buckets,
      totals: rollup.totals,
      rates: listRunnerRates(),
    };
  });

  server.get("/api/work-items", async (request) => {
    const query = request.query as { from?: string; to?: string; status?: string; search?: string };
    if (query.from !== undefined && !isIsoDate(query.from)) {
      throw new ForemanError("invalid_request", "Query parameter from must be YYYY-MM-DD.", 400);
    }
    if (query.to !== undefined && !isIsoDate(query.to)) {
      throw new ForemanError("invalid_request", "Query parameter to must be YYYY-MM-DD.", 400);
    }
    const statusFilter = parseEnumQuery("status", query.status, attemptStatuses);

    let range;
    try {
      range = resolveUsageRange({
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
        defaultLookbackDays: 30,
      });
    } catch (error) {
      throw new ForemanError(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid work-items range.",
        400,
      );
    }

    const rows = deps.repos.attempts.listWorkItemRows({
      fromInclusive: range.fromInclusive,
      toExclusive: range.toExclusive,
    });
    const rollup = rollupWorkItems({
      rows,
      fromInclusive: range.fromInclusive,
      toExclusive: range.toExclusive,
    });

    const searchTerm = query.search?.trim().toLowerCase() ?? "";
    const filteredBuckets = rollup.buckets
      .filter((bucket) => (statusFilter ? bucket.effectiveStatus === statusFilter : true))
      .filter((bucket) => (searchTerm ? bucket.taskId.toLowerCase().includes(searchTerm) : true))
      .map((bucket) => ({
        ...bucket,
        taskUrl: resolveTaskUrl(deps, bucket.taskId),
      }));

    // Totals must match what we actually return in buckets; rollup.totals
    // covers the unfiltered window, so a non-empty status/search filter would
    // make the two diverge for any totals-footer or KPI-card consumer.
    const totals =
      statusFilter === undefined && searchTerm === ""
        ? rollup.totals
        : sumWorkItemTotals(filteredBuckets);

    return {
      fromDate: range.fromDate,
      toDate: range.toDate,
      fromInclusive: rollup.fromInclusive,
      toExclusive: rollup.toExclusive,
      buckets: filteredBuckets,
      totals,
      rates: listRunnerRates(),
    };
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

  server.get("/api/settings", async () => settingsResponse(deps.config, deps.paths));

  server.patch("/api/settings", async (request) => {
    const body = request.body;
    if (!isRecord(body)) {
      throw new ForemanError("invalid_request", "Settings patch body must be an object.", 400);
    }

    const previousScheduler = { ...deps.config.scheduler };
    const nextConfig = applySettingsPatch(deps.config, body);
    assignWorkspaceConfig(deps.config, nextConfig);
    deps.scheduler.syncConfigUpdate(previousScheduler);
    await fs.writeFile(deps.paths.configPath, stringifyWorkspaceConfig(deps.config));
    return settingsResponse(deps.config, deps.paths);
  });

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

  server.post("/api/system/reboot", async () => {
    if (!deps.rebootScheduler) {
      throw new ForemanError("reboot_unavailable", "System reboot is unavailable for this server.", 503);
    }

    return { reboot: deps.rebootScheduler.scheduleReboot() };
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
