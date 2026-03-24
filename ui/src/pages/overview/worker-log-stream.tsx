import type { CSSProperties } from "react"
import { useEffect, useMemo, useRef, useState } from "react"

import { getAttemptLogs, type Worker } from "@/lib/api"
import {
  appendLogChunk,
  appendSyntheticLogLine,
  createLogBuffer,
  getDisplayLines,
} from "@/lib/log-display"
import { cn } from "@/lib/utils"

type WorkerLogStreamProps = {
  worker: Worker | null
}

export function WorkerLogStream({ worker }: WorkerLogStreamProps) {
  const [buffer, setBuffer] = useState(() => createLogBuffer())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lines = useMemo(() => getDisplayLines(buffer), [buffer])

  useEffect(() => {
    if (!worker) {
      setBuffer(createLogBuffer())
      setLoading(false)
      setError(null)
      return
    }

    let isActive = true
    let source: EventSource | null = null

    setBuffer(createLogBuffer())
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
        setBuffer(appendLogChunk(createLogBuffer(), initialLogs))
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

        setBuffer((current) => appendLogChunk(current, `${event.data}\n`))
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
          setBuffer((current) => appendSyntheticLogLine(current, marker))
        } catch {
          setBuffer((current) => appendSyntheticLogLine(current, "[worker state changed]"))
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
  }, [lines])

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
          "max-h-[52rem] min-h-[44rem] overflow-auto p-4 font-mono text-xs leading-6 text-foreground",
          lines.length === 0 && "flex items-center justify-center"
        )}
      >
        {loading && lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Attaching to worker log stream...</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Worker has not produced logs yet.</p>
        ) : (
          <div className="m-0 whitespace-pre-wrap break-words">
            {lines.map((line, index) => (
              <div key={`log-line-${index}`}>
                {line.segments.length === 0 ? (
                  <span>&nbsp;</span>
                ) : (
                  line.segments.map((segment, segmentIndex) => (
                    <span
                      key={`log-segment-${index}-${segmentIndex}`}
                      className={cn(segment.classes)}
                      style={segment.style as CSSProperties}
                    >
                      {segment.text}
                    </span>
                  ))
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
