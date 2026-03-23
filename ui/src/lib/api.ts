export type SchedulerStatus = "running" | "paused" | "stopping" | "stopped"

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

export function getStatus() {
  return requestJson<StatusResponse>("/api/status")
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
