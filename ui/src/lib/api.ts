export type SchedulerStatus = "running" | "paused" | "stopping" | "stopped"
export type AttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "canceled"
  | "timed_out"
export type WorkerStatus = "idle" | "leased" | "running" | "stopping" | "offline"
export type ActionType = "execution" | "review" | "reviewer" | "retry" | "deployment" | "consolidation" | "cron"
export type LearningConfidence = "emerging" | "established" | "proven"
export type CronSettings = {
  enabled: boolean
  jobsDir: string
}
export type AgentTaskCreationSettings = {
  enabled: boolean
}
export type RunnerProvider =
  | {
      type: "opencode"
      model: string
      variant: string
      timeoutMs: number
    }
  | {
      type: "claude"
      model: string
      effort: string
      timeoutMs: number
    }
  | {
      type: "codex"
      model: string
      effort: string
      timeoutMs: number
    }
export type TaskProviderStates = {
  ready: string[]
  inProgress: string[]
  inReview: string[]
  deployable: string[]
  done: string[]
  canceled: string[]
}
export type WorkspaceConfig = {
  version: 1
  workspace: {
    name: string
    agentPrefix: string
  }
  repos: {
    explicit: string[]
    roots: string[]
    ignore: string[]
    reposDoneOnMerge: string[]
  }
  taskSystem: {
    type: "linear" | "file"
    linear?: {
      team: string
      assignee: string
      includeLabels: string[]
      agentCreatedLabel: string
      consolidatedLabel: string
      states: TaskProviderStates
    }
    file?: {
      tasksDir: string
      idPrefix: string
      states: TaskProviderStates
    }
  }
  reviewSystem: {
    type: "github"
  }
  runner: {
    execution: RunnerProvider
    reviewer: RunnerProvider
  }
  reviewer: {
    agentPrefix: string
  }
  cron: CronSettings
  agentTaskCreation: AgentTaskCreationSettings
  deployment: {
    minRetryIntervalMinutes: number
    maxRetryIntervalMinutes: number
  }
  scheduler: {
    workerConcurrency: number
    scoutPollIntervalSeconds: number
    scoutRerunDebounceMs: number
    leaseTtlSeconds: number
    workerHeartbeatSeconds: number
    staleLeaseReapIntervalSeconds: number
    schedulerLoopIntervalMs: number
    shutdownGracePeriodSeconds: number
  }
  http: {
    host: string
    port: number
  }
}
export type DeepPartial<T> = T extends Array<infer U>
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T
export type SettingsPatch = DeepPartial<WorkspaceConfig>
export type TaskState =
  | "ready"
  | "in_progress"
  | "in_review"
  | "deployable"
  | "done"
  | "canceled"
export type TargetProgressState =
  | "pending"
  | "active"
  | "in_review"
  | "merged"
  | "completed"
  | "retryable"

export type StatusResponse = {
  workspace: {
    name: string
    root: string
  }
  scheduler: {
    status: SchedulerStatus
    workerConcurrency: number
    scoutPollIntervalSeconds: number
    lastScoutRunAt: string | null
    nextScoutPollAt: string | null
  }
  cron: CronSettings
  agentTaskCreation: AgentTaskCreationSettings
  integrations: {
    taskSystem: { type: string; status: string }
    reviewSystem: { type: string; status: string }
    runners: {
      execution: { type: string; model: string; status: string }
      reviewer: { type: string; model: string; status: string }
    }
  }
  repos: {
    count: number
    keys: string[]
  }
  version: {
    commit: string | null
    shortCommit: string | null
    upstreamRef: string | null
    upstreamCommit: string | null
    behindBy: number | null
    updateAvailable: boolean
    checkedAt: string | null
    errorMessage: string | null
  }
}

type SchedulerMutationResponse = {
  scheduler: {
    status: SchedulerStatus
  }
}

type ScoutMutationResponse = {
  scout: {
    status: string
    trigger: string
  }
}

export type RebootMutationResponse = {
  reboot: {
    status: "scheduled"
  }
}

type StopAttemptResponse = {
  attemptId: string
  stopRequested: boolean
}

export type Worker = {
  id: string
  slot: number
  status: WorkerStatus
  currentAttemptId: string | null
  lastHeartbeatAt: string
  currentAttempt: {
    id: string
    jobId: string
    status: AttemptStatus
    startedAt: string
  } | null
  currentJob: {
    id: string
    jobKind: "task" | "cron"
    taskId: string | null
    taskUrl: string | null
    taskTargetId: string | null
    cronJobId: string | null
    action: ActionType
    repoKey: string | null
    status: string
  } | null
}

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  reasoningOutputTokens?: number
}

export type AttemptRecord = {
  id: string
  jobId: string
  jobKind: "task" | "cron"
  taskId: string | null
  taskUrl: string | null
  target: string | null
  cronJobId: string | null
  stage: ActionType | null
  workerId: string | null
  attemptNumber: number
  runnerName: "opencode" | "claude" | "codex"
  runnerModel: string
  runnerVariant: string
  nativeSessionId: string | null
  worktreePath: string | null
  status: AttemptStatus
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  signal: string | null
  summary: string
  errorMessage: string | null
  tokensUsed: TokenUsage | null
}

export type AttemptEventRecord = {
  id: string
  eventType: string
  message: string
  payload: Record<string, unknown>
  createdAt: string
}

export type ArtifactType =
  | "log"
  | "rendered_prompt"
  | "parsed_result"
  | "runner_output"
  | "plan_prompt"
  | "plan_context"

export type ArtifactRecord = {
  id: string
  ownerType: "workspace" | "job" | "execution_attempt" | "scout_run"
  ownerId: string
  artifactType: ArtifactType
  relativePath: string
  mediaType: string
  sizeBytes: number
  sha256: string | null
  createdAt: string
}

export type AttemptDetail = {
  attempt: AttemptRecord
  events: AttemptEventRecord[]
  artifacts: ArtifactRecord[]
}

export type SettingsResponse = {
  config: WorkspaceConfig
  deploymentInstructions: {
    active: boolean
    relativePath: string
  }
}

export type TaskPullRequest = {
  repoKey: string
  url: string
  title?: string
  source: "local" | "provider" | "provider_inferred" | "branch_inferred"
}

export type TaskTargetReview = {
  pullRequestUrl: string
  pullRequestNumber: number
  state: "open" | "closed" | "merged"
  isDraft: boolean
  baseBranch: string
  headBranch: string
}

export type TaskTargetSummary = {
  id: string
  taskId: string
  repoKey: string
  branchName: string
  status: TaskState | "blocked"
  progressState: TargetProgressState
  review: TaskTargetReview | null
}

export type TaskListItem = {
  id: string
  title: string
  state: TaskState
  updatedAt: string
  url: string | null
  pullRequests: TaskPullRequest[]
  targets: TaskTargetSummary[]
}

export type LearningRecord = {
  id: string
  title: string
  repo: string
  tags: string[]
  confidence: LearningConfidence
  content: string
  appliedCount: number
  readCount: number
  createdAt: string
  updatedAt: string
}

export type ScoutRun = {
  id: string
  triggerType: "startup" | "poll" | "worker_finished" | "task_mutation" | "lease_change" | "manual"
  status: "running" | "completed" | "failed"
  startedAt: string
  finishedAt: string | null
  selectedAction: ActionType | null
  selectedTaskId: string | null
  candidateCount: number
  activeCount: number
  terminalCount: number
}

type ErrorPayload = {
  error?: {
    message?: string
  }
}

class ApiError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = "ApiError"
    this.statusCode = statusCode
  }
}

async function requestJson<T>(input: string, init?: RequestInit) {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`

    try {
      const payload = (await response.json()) as ErrorPayload
      message = payload.error?.message ?? message
    } catch {
      // Ignore JSON parse issues and fall back to status text.
    }

    throw new ApiError(message, response.status)
  }

  return (await response.json()) as T
}

async function requestText(input: string, init?: RequestInit) {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: "text/plain",
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    throw new ApiError(`${response.status} ${response.statusText}`, response.status)
  }

  return response.text()
}

function buildSearch(
  params: Record<string, string | number | boolean | undefined>
) {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue
    }
    search.set(key, String(value))
  }

  const built = search.toString()
  return built ? `?${built}` : ""
}

export function getStatus() {
  return requestJson<StatusResponse>("/api/status")
}

export function getSettings() {
  return requestJson<SettingsResponse>("/api/settings")
}

export function patchSettings(patch: SettingsPatch) {
  return requestJson<SettingsResponse>("/api/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  })
}

export function listWorkers() {
  return requestJson<{ workers: Worker[] }>("/api/workers").then(
    (payload) => payload.workers
  )
}

export function getAttemptLogs(attemptId: string) {
  return requestText(`/api/attempts/${attemptId}/logs`)
}

export function getAttempt(attemptId: string) {
  return requestJson<AttemptDetail>(`/api/attempts/${attemptId}`)
}

export function stopAttempt(attemptId: string) {
  return requestJson<StopAttemptResponse>(`/api/attempts/${attemptId}/stop`, {
    method: "POST",
  })
}

export function getArtifactContent(artifactId: string) {
  return requestText(`/api/artifacts/${artifactId}/content`)
}

export function listAttempts(params: {
  status?: AttemptStatus
  jobId?: string
  limit?: number
  offset?: number
}) {
  return requestJson<{ attempts: AttemptRecord[] }>(
    `/api/attempts${buildSearch(params)}`
  ).then((payload) => payload.attempts)
}

export function listTasks(params: {
  state?: TaskState
  search?: string
  limit?: number
  refreshReview?: boolean
}) {
  return requestJson<{ tasks: TaskListItem[] }>(
    `/api/tasks${buildSearch(params)}`
  ).then((payload) => payload.tasks)
}

export function listLearnings(params: {
  search?: string
  repo?: string
  limit?: number
  offset?: number
}) {
  return requestJson<{ learnings: LearningRecord[] }>(
    `/api/learnings${buildSearch(params)}`
  ).then((payload) => payload.learnings)
}

export type UsageGroupBy = "day" | "runner" | "model"

export type UsageRate = {
  runnerName: "claude" | "codex" | "opencode"
  runnerModel: string
  inputPerMtok: number
  outputPerMtok: number
  cacheReadPerMtok: number
  cacheWriteFiveMinPerMtok: number
}

export type UsageBucket = {
  groupKey: string
  attemptsCount: number
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheCreationInputTokens: number
    cacheReadInputTokens: number
    reasoningOutputTokens: number
  }
  cost: {
    totalUsd: number
    breakdown: {
      input: number
      output: number
      cacheRead: number
      cacheCreate: number
      reasoning: number
    }
  }
}

export type UsageRollupResponse = {
  groupBy: UsageGroupBy
  fromDate: string
  toDate: string
  fromInclusive: string
  toExclusive: string
  buckets: UsageBucket[]
  totals: UsageBucket
  rates: UsageRate[]
}

export function getUsage(params: { from?: string; to?: string; groupBy?: UsageGroupBy }) {
  return requestJson<UsageRollupResponse>(`/api/usage${buildSearch(params)}`)
}

export function getRates() {
  return requestJson<{ rates: UsageRate[] }>("/api/rates").then((payload) => payload.rates)
}

export function listScoutRuns() {
  return requestJson<{ runs: ScoutRun[] }>("/api/scout/runs").then(
    (payload) => payload.runs
  )
}

export function startScheduler() {
  return requestJson<SchedulerMutationResponse>("/api/scheduler/start", {
    method: "POST",
  })
}

export function pauseScheduler() {
  return requestJson<SchedulerMutationResponse>("/api/scheduler/pause", {
    method: "POST",
  })
}

export function stopScheduler() {
  return requestJson<SchedulerMutationResponse>("/api/scheduler/stop", {
    method: "POST",
  })
}

export function runScout() {
  return requestJson<ScoutMutationResponse>("/api/scout/run", {
    method: "POST",
  })
}

export function rebootSystem() {
  return requestJson<RebootMutationResponse>("/api/system/reboot", {
    method: "POST",
  })
}
