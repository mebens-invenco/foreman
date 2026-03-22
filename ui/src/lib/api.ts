export type SchedulerStatus = "running" | "paused" | "stopped" | "stopping";
export type TaskState = "ready" | "in_progress" | "in_review" | "done" | "canceled";
export type AttemptStatus = "running" | "completed" | "failed" | "blocked" | "canceled" | "timed_out";
export type WorkerStatus = "idle" | "leased" | "running" | "stopping" | "offline";
export type ActionType = "execution" | "review" | "retry" | "consolidation";
export type SchedulerAction = "start" | "pause" | "stop";
export type TaskTargetStatus = TaskState | "blocked";

export type TaskTargetView = {
  id: string;
  repoKey: string;
  branchName: string;
  status: TaskTargetStatus;
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
    action: ActionType;
    status: string;
    createdAt: string;
    finishedAt: string | null;
  } | null;
  latestAttempt: {
    id: string;
    status: AttemptStatus;
    startedAt: string;
    finishedAt: string | null;
  } | null;
};

export type TaskPullRequest = {
  repoKey: string;
  url: string;
  title?: string;
  source: "local" | "provider" | "provider_inferred" | "branch_inferred";
};

export type StatusResponse = {
  workspace: {
    name: string;
    root: string;
  };
  scheduler: {
    status: SchedulerStatus;
    workerConcurrency: number;
    scoutPollIntervalSeconds: number;
    lastScoutRunAt: string | null;
    nextScoutPollAt: string | null;
  };
  integrations: {
    taskSystem: { type: string; status: string };
    reviewSystem: { type: string; status: string };
    runner: { type: string; status: string };
  };
  repos: {
    count: number;
    keys: string[];
  };
};

export type Worker = {
  id: string;
  slot: number;
  status: WorkerStatus;
  currentAttemptId: string | null;
  lastHeartbeatAt: string;
  currentAttempt: {
    id: string;
    jobId: string;
    status: AttemptStatus;
    startedAt: string;
  } | null;
  currentJob: {
    id: string;
    taskId: string;
    taskTargetId: string;
    action: ActionType;
    repoKey: string;
    status: string;
  } | null;
};

export type QueueJob = {
  id: string;
  taskId: string;
  taskTargetId?: string;
  action: ActionType;
  status: string;
  priorityRank: number;
  repoKey: string;
  createdAt: string;
};

export type TaskListItem = {
  id: string;
  provider: string;
  title: string;
  state: TaskState;
  providerState: string;
  priority: string;
  updatedAt: string;
  url: string | null;
  pullRequests: TaskPullRequest[];
  targets: TaskTargetView[];
};

export type Attempt = {
  id: string;
  jobId: string;
  workerId: string | null;
  attemptNumber: number;
  runnerName: string;
  runnerModel: string;
  runnerVariant: string;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  summary: string;
  errorMessage: string | null;
};

export type AttemptEvent = {
  id: string;
  eventType: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type Artifact = {
  id: string;
  ownerType: string;
  ownerId: string;
  artifactType: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
};

export type ScoutRun = {
  id: string;
  triggerType: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  selectedAction: ActionType | null;
  selectedTaskId: string | null;
  candidateCount: number;
  activeCount: number;
  terminalCount: number;
};

export type HistoryRecord = {
  stepId: string;
  createdAt: string;
  stage: string;
  issue: string;
  summary: string;
  repos: Array<{
    path: string;
    beforeSha: string;
    afterSha: string;
    position: number;
  }>;
};

export type LearningRecord = {
  id: string;
  title: string;
  repo: string;
  tags: string[];
  confidence: "emerging" | "established" | "proven";
  content: string;
  appliedCount: number;
  readCount: number;
  createdAt: string;
  updatedAt: string;
};

const buildSearch = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const built = search.toString();
  return built ? `?${built}` : "";
};

const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const fallback = `${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      throw new Error(payload.error?.message ?? fallback);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(fallback);
    }
  }

  return (await response.json()) as T;
};

export const api = {
  fetchStatus: () => requestJson<StatusResponse>("/api/status"),
  listWorkers: () => requestJson<{ workers: Worker[] }>("/api/workers").then((payload) => payload.workers),
  listQueue: () => requestJson<{ jobs: QueueJob[] }>("/api/queue").then((payload) => payload.jobs),
  listScoutRuns: () => requestJson<{ runs: ScoutRun[] }>("/api/scout/runs").then((payload) => payload.runs),
  listTasks: (params: { state?: TaskState; search?: string; limit?: number }) =>
    requestJson<{ tasks: TaskListItem[] }>(`/api/tasks${buildSearch(params)}`).then((payload) => payload.tasks),
  listAttempts: (params: { status?: AttemptStatus; jobId?: string; limit?: number; offset?: number }) =>
    requestJson<{ attempts: Attempt[] }>(`/api/attempts${buildSearch(params)}`).then((payload) => payload.attempts),
  getAttempt: (attemptId: string) => requestJson<{ attempt: Attempt; events: AttemptEvent[]; artifacts: Artifact[] }>(`/api/attempts/${attemptId}`),
  getAttemptLogs: (attemptId: string) =>
    fetch(`/api/attempts/${attemptId}/logs`).then(async (response) => {
      if (!response.ok) {
        throw new Error("Failed to load attempt logs");
      }
      return response.text();
    }),
  listHistory: (params: { stage?: string; repo?: string; search?: string; limit?: number; offset?: number }) =>
    requestJson<{ history: HistoryRecord[] }>(`/api/history${buildSearch(params)}`).then((payload) => payload.history),
  listLearnings: (params: { search?: string; repo?: string; limit?: number; offset?: number }) =>
    requestJson<{ learnings: LearningRecord[] }>(`/api/learnings${buildSearch(params)}`).then((payload) => payload.learnings),
  postSchedulerAction: (action: SchedulerAction) => requestJson(`/api/scheduler/${action}`, { method: "POST" }),
  runScout: () => requestJson("/api/scout/run", { method: "POST" }),
};

export const queryKeys = {
  status: ["status"] as const,
  workers: ["workers"] as const,
  queue: ["queue"] as const,
  tasks: (params: { state?: TaskState; search?: string; limit?: number }) => ["tasks", params] as const,
  attempts: (params: { status?: AttemptStatus; jobId?: string; limit?: number; offset?: number }) => ["attempts", params] as const,
  attempt: (attemptId: string | null) => ["attempt", attemptId] as const,
  history: (params: { stage?: string; repo?: string; search?: string; limit?: number; offset?: number }) => ["history", params] as const,
  learnings: (params: { search?: string; repo?: string; limit?: number; offset?: number }) => ["learnings", params] as const,
};
