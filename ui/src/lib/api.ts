export type SchedulerStatus = "running" | "paused" | "stopping" | "stopped"
export type AttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "canceled"
  | "timed_out"
export type WorkerStatus = "idle" | "leased" | "running" | "stopping" | "offline"
export type ActionType = "execution" | "review" | "retry" | "consolidation"

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
  integrations: {
    taskSystem: { type: string; status: string }
    reviewSystem: { type: string; status: string }
    runner: { type: string; status: string }
  }
  repos: {
    count: number
    keys: string[]
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
    taskId: string
    taskTargetId: string
    action: ActionType
    repoKey: string
    status: string
  } | null
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

export function getStatus() {
  return requestJson<StatusResponse>("/api/status")
}

export function listWorkers() {
  return requestJson<{ workers: Worker[] }>("/api/workers").then(
    (payload) => payload.workers
  )
}

export function getAttemptLogs(attemptId: string) {
  return requestText(`/api/attempts/${attemptId}/logs`)
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
