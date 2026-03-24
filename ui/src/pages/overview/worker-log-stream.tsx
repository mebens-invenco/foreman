import { useEffect, useRef, useState } from "react"

import { getAttemptLogs, type Worker } from "@/lib/api"
import { cn } from "@/lib/utils"

const MAX_LOG_CHARS = 120_000

function trimLogOutput(value: string) {
  if (value.length <= MAX_LOG_CHARS) {
    return value
  }

  return value.slice(value.length - MAX_LOG_CHARS)
}

function appendChunk(current: string, chunk: string) {
  return trimLogOutput(current + chunk)
}

function appendMarker(current: string, marker: string) {
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
  return trimLogOutput(`${current}${prefix}${marker}\n`)
}

type WorkerLogStreamProps = {
  worker: Worker | null
}

export function WorkerLogStream({ worker }: WorkerLogStreamProps) {
  const [logs, setLogs] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!worker) {
      setLogs("")
      setLoading(false)
      setError(null)
      return
    }

    let isActive = true
    let source: EventSource | null = null

    setLogs("")
    setLoading(true)
    setError(null)

    const loadInitialLogs = async () => {
      if (!worker.currentAttemptId) {
        return
      }

      try {
        const initialLogs = await getAttemptLogs(worker.currentAttemptId)
        if (!isActive) {
          return
        }
        setLogs(trimLogOutput(initialLogs))
      } catch {
        // Ignore missing attempt logs and continue with the live stream.
      }
    }

    void loadInitialLogs().finally(() => {
      if (!isActive) {
        return
      }

      source = new EventSource(`/api/workers/${worker.id}/logs/stream`)

      source.addEventListener("log", (event) => {
        if (!isActive || !(event instanceof MessageEvent)) {
          return
        }

        setLogs((current) => appendChunk(current, event.data))
        setLoading(false)
      })

      source.addEventListener("attempt_changed", (event) => {
        if (!isActive || !(event instanceof MessageEvent)) {
          return
        }

        try {
          const payload = JSON.parse(event.data) as { attemptId?: string | null }
          const marker = payload.attemptId
            ? `[worker switched to ${payload.attemptId}]`
            : "[worker is idle]"
          setLogs((current) => appendMarker(current, marker))
        } catch {
          setLogs((current) => appendMarker(current, "[worker state changed]"))
        }

        setLoading(false)
      })

      source.addEventListener("error", () => {
        if (!isActive) {
          return
        }

        setError("Live log stream interrupted. Waiting for more output...")
        setLoading(false)
      })

      source.addEventListener("open", () => {
        if (!isActive) {
          return
        }

        setError(null)
        setLoading(false)
      })

      if (!worker.currentAttemptId) {
        setLoading(false)
      }
    })

    return () => {
      isActive = false
      source?.close()
    }
  }, [worker?.id, worker?.currentAttemptId])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }

    element.scrollTop = element.scrollHeight
  }, [logs])

  return (
    <div className="border border-border/70 bg-background/75">
      {error ? (
        <div className="border-b border-border/70 px-4 py-2 text-[11px] uppercase tracking-[0.22em] text-amber-700 dark:text-amber-300">
          {error}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className={cn(
          "max-h-[26rem] min-h-[22rem] overflow-auto p-4 font-mono text-xs leading-6 text-foreground",
          logs.length === 0 && "flex items-center justify-center"
        )}
      >
        {loading && logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Attaching to worker log stream...</p>
        ) : logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Worker has not produced logs yet.</p>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words">{logs}</pre>
        )}
      </div>
    </div>
  )
}
