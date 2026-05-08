import type { CSSProperties, ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"

import { useQuery } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TaskLink } from "@/components/task-link"
import {
  getArtifactContent,
  getAttempt,
  getAttemptLogs,
  type ArtifactRecord,
  type AttemptEventRecord,
  type AttemptRecord,
} from "@/lib/api"
import { formatActionLabel, formatDuration, formatTimestamp } from "@/lib/format"
import {
  appendLogChunk,
  createLogBuffer,
  getDisplayLines,
} from "@/lib/log-display"
import { cn } from "@/lib/utils"

type AttemptDetailSheetProps = {
  attemptId: string | null
}

type AttemptDetailTab = "events" | "logs" | "artifacts"

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

function statusTone(status: AttemptRecord["status"]) {
  switch (status) {
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "failed":
    case "blocked":
      return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
    case "canceled":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    default:
      return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildOpenSessionCommand(attempt: AttemptRecord) {
  if (!attempt.nativeSessionId || !attempt.worktreePath) {
    return null
  }

  const sessionId = shellQuote(attempt.nativeSessionId)
  const prefix = `cd ${shellQuote(attempt.worktreePath)} && `

  switch (attempt.runnerName) {
    case "opencode":
      return `${prefix}opencode -s ${sessionId}`
    case "claude":
      return `${prefix}claude --resume ${sessionId}`
  }
}

function AttemptStatusBadge({ status }: { status: AttemptRecord["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-none border px-2 py-1 text-xxs font-medium tracking-[0.18em] uppercase",
        statusTone(status)
      )}
    >
      {formatStatusLabel(status)}
    </span>
  )
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border border-border/70 bg-background/70 px-4 py-3">
      <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
        {label}
      </p>
      <div className="mt-2 text-sm leading-6 break-all text-foreground">
        {value}
      </div>
    </div>
  )
}

function OpenSessionSection({ attempt }: { attempt: AttemptRecord }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const command = buildOpenSessionCommand(attempt)

  useEffect(() => {
    if (copyState === "idle") {
      return
    }

    const timeoutId = window.setTimeout(() => setCopyState("idle"), 2000)
    return () => window.clearTimeout(timeoutId)
  }, [copyState])

  if (!command) {
    return null
  }

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  return (
    <section className="border border-border/70 bg-background/70 px-4 py-3">
      <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
        Open session
      </p>
      <pre className="mt-3 flex items-center gap-3 overflow-auto border border-border/70 bg-muted/35 p-3 font-mono text-xs leading-6 text-foreground">
        <code className="min-w-0 flex-1 break-all whitespace-pre-wrap">{command}</code>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="font-sans"
          onClick={copyCommand}
        >
          {copyState === "copied"
            ? "Copied"
            : copyState === "failed"
              ? "Failed"
              : "Copy"}
        </Button>
      </pre>
    </section>
  )
}

function formatArtifactType(value: string) {
  return value.replace(/_/g, " ")
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatJsonContent(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

function AttemptLogPanel({ attempt }: { attempt: AttemptRecord | null }) {
  const [buffer, setBuffer] = useState(() => createLogBuffer())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lines = useMemo(() => getDisplayLines(buffer), [buffer])

  useEffect(() => {
    if (!attempt) {
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

    const loadLogs = async () => {
      let offset = 0

      try {
        const initialLogs = await getAttemptLogs(attempt.id)
        offset = initialLogs.length
        if (!isActive) {
          return
        }
        setBuffer(appendLogChunk(createLogBuffer(), initialLogs))
      } catch {
        // Missing logs are normal for attempts that have not emitted output yet.
      }

      if (!isActive) {
        return
      }

      if (attempt.status !== "running") {
        setLoading(false)
        return
      }

      source = new EventSource(
        `/api/attempts/${encodeURIComponent(attempt.id)}/logs/stream?offset=${offset}`
      )

      source.addEventListener("log", (event) => {
        if (!isActive || !(event instanceof MessageEvent)) {
          return
        }

        setBuffer((current) => appendLogChunk(current, `${event.data}\n`))
        setLoading(false)
      })

      source.addEventListener("open", () => {
        if (!isActive) {
          return
        }

        setError(null)
        setLoading(false)
      })

      source.addEventListener("error", () => {
        if (!isActive) {
          return
        }

        setError("Live log stream interrupted. Waiting for more output...")
        setLoading(false)
      })
    }

    void loadLogs()

    return () => {
      isActive = false
      source?.close()
    }
  }, [attempt?.id, attempt?.status])

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
        <div className="border-b border-border/70 px-4 py-2 text-xs tracking-[0.22em] text-amber-700 uppercase dark:text-amber-300">
          {error}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className={cn(
          "max-h-[32rem] min-h-[22rem] overflow-auto p-4 font-mono text-xs leading-6 text-foreground",
          lines.length === 0 && "flex items-center justify-center"
        )}
      >
        {loading && lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading attempt logs...</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">No logs recorded for this attempt.</p>
        ) : (
          <div className="m-0 whitespace-pre-wrap break-words">
            {lines.map((line, index) => (
              <div key={`attempt-log-line-${index}`}>
                {line.segments.length === 0 ? (
                  <span>&nbsp;</span>
                ) : (
                  line.segments.map((segment, segmentIndex) => (
                    <span
                      key={`attempt-log-segment-${index}-${segmentIndex}`}
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

function ArtifactContent({ artifact }: { artifact: ArtifactRecord | null }) {
  const query = useQuery({
    queryKey: ["foreman", "artifact-content", artifact?.id],
    queryFn: () => getArtifactContent(artifact!.id),
    enabled: Boolean(artifact),
  })

  if (!artifact) {
    return (
      <div className="flex min-h-[18rem] items-center justify-center border border-dashed border-border/70 bg-background/65 p-6 text-sm text-muted-foreground">
        No artifact selected.
      </div>
    )
  }

  if (query.isLoading) {
    return (
      <div className="flex min-h-[18rem] items-center justify-center border border-border/70 bg-background/65 p-6 text-sm text-muted-foreground">
        Loading artifact content...
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
        {query.error instanceof Error
          ? query.error.message
          : "Failed to load artifact content."}
      </div>
    )
  }

  const content = query.data ?? ""
  const isJson =
    artifact.artifactType === "parsed_result" || artifact.mediaType.includes("json")
  const displayContent = isJson ? formatJsonContent(content) : content

  return (
    <pre className="max-h-[34rem] min-h-[18rem] overflow-auto border border-border/70 bg-muted/35 p-4 font-mono text-xs leading-6 whitespace-pre-wrap break-words text-foreground">
      {displayContent || "Artifact file is empty."}
    </pre>
  )
}

function ArtifactsPanel({ artifacts }: { artifacts: ArtifactRecord[] }) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedArtifactId((current) => {
      if (current && artifacts.some((artifact) => artifact.id === current)) {
        return current
      }

      return (
        artifacts.find((artifact) => artifact.artifactType === "runner_output")?.id ??
        artifacts.find((artifact) => artifact.artifactType === "rendered_prompt")?.id ??
        artifacts[0]?.id ??
        null
      )
    })
  }, [artifacts])

  const selectedArtifact =
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null

  if (artifacts.length === 0) {
    return (
      <div className="border border-dashed border-border/70 bg-background/65 px-4 py-6 text-sm text-muted-foreground">
        No artifacts recorded for this attempt.
      </div>
    )
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]">
      <div className="space-y-2">
        {artifacts.map((artifact) => (
          <Button
            key={artifact.id}
            type="button"
            variant={artifact.id === selectedArtifactId ? "secondary" : "outline"}
            className="h-auto w-full justify-start px-3 py-2 text-left whitespace-normal"
            onClick={() => setSelectedArtifactId(artifact.id)}
          >
            <span className="min-w-0">
              <span className="block text-xs tracking-[0.18em] uppercase">
                {formatArtifactType(artifact.artifactType)}
              </span>
              <span className="mt-1 block truncate font-mono text-xxs text-muted-foreground">
                {artifact.relativePath}
              </span>
              <span className="mt-1 block text-xxs text-muted-foreground">
                {formatBytes(artifact.sizeBytes)}
              </span>
            </span>
          </Button>
        ))}
      </div>

      <div className="min-w-0 space-y-3">
        {selectedArtifact ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <DetailRow label="Artifact" value={formatArtifactType(selectedArtifact.artifactType)} />
            <DetailRow label="Media type" value={selectedArtifact.mediaType} />
          </div>
        ) : null}
        <ArtifactContent artifact={selectedArtifact} />
      </div>
    </div>
  )
}

function EventsPanel({ events }: { events: AttemptEventRecord[] }) {
  if (events.length === 0) {
    return (
      <div className="border border-dashed border-border/70 bg-background/65 px-4 py-6 text-sm text-muted-foreground">
        No events recorded for this attempt.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <div
          key={event.id}
          className="border border-border/70 bg-background/70 px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs tracking-[0.22em] text-foreground uppercase">
              {formatArtifactType(event.eventType)}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatTimestamp(event.createdAt)}
            </p>
          </div>
          <p className="mt-2 text-sm leading-6 text-foreground">
            {event.message}
          </p>
          {Object.keys(event.payload).length > 0 ? (
            <pre className="mt-3 overflow-auto bg-muted/35 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function AttemptDetailSheet({ attemptId }: AttemptDetailSheetProps) {
  const [detailTab, setDetailTab] = useState<AttemptDetailTab>("events")
  const query = useQuery({
    queryKey: ["foreman", "attempt", attemptId],
    queryFn: () => getAttempt(attemptId!),
    enabled: Boolean(attemptId),
    refetchInterval: 5_000,
  })
  const detail = query.data
  const attempt = detail?.attempt ?? null
  const events = detail?.events ?? []
  const artifacts = detail?.artifacts ?? []
  const isCronAttempt = attempt?.jobKind === "cron"
  const workItemLabel = isCronAttempt ? "Cron job" : "Task"
  const workItemValue = isCronAttempt ? attempt?.cronJobId : attempt?.taskId
  const taskUrl = isCronAttempt ? null : attempt?.taskUrl ?? null
  const targetLabel = isCronAttempt ? "Scope" : "Target"
  const targetValue = isCronAttempt ? "Workspace" : attempt?.target

  return (
    <SheetContent
      side="right"
      className="data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:w-[min(64rem,calc(100vw-2rem))] data-[side=right]:sm:max-w-[min(64rem,calc(100vw-2rem))] data-[side=right]:xl:w-[min(78rem,calc(100vw-4rem))] data-[side=right]:xl:max-w-[min(78rem,calc(100vw-4rem))]"
    >
      <SheetHeader className="border-b border-border/70 pr-12">
        <div className="flex items-start justify-between gap-4">
          <div>
            <SheetTitle>Attempt details</SheetTitle>
            <SheetDescription className="mt-2 font-mono text-xs text-muted-foreground">
              {attemptId ?? "No attempt selected"}
            </SheetDescription>
          </div>
          {attempt ? <AttemptStatusBadge status={attempt.status} /> : null}
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
        {query.isLoading ? (
          <div className="border border-border/70 bg-background/70 px-4 py-6 text-sm text-muted-foreground">
            Loading attempt details...
          </div>
        ) : query.isError ? (
          <div className="border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            {query.error instanceof Error
              ? query.error.message
              : "Failed to load attempt details."}
          </div>
        ) : attempt ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <DetailRow
                label={workItemLabel}
                value={
                  workItemValue ? (
                    <TaskLink taskUrl={taskUrl}>{workItemValue}</TaskLink>
                  ) : (
                    "-"
                  )
                }
              />
              <DetailRow label={targetLabel} value={targetValue ?? "-"} />
              <DetailRow label="Stage" value={formatActionLabel(attempt.stage)} />
              <DetailRow label="Worker" value={attempt.workerId ?? "-"} />
              <DetailRow label="Job" value={attempt.jobId} />
              <DetailRow label="Runner" value={attempt.runnerName} />
              <DetailRow label="Model" value={attempt.runnerModel} />
              <DetailRow label="Variant" value={attempt.runnerVariant} />
              <DetailRow label="Session" value={attempt.nativeSessionId ?? "-"} />
              <DetailRow label="Started" value={formatTimestamp(attempt.startedAt)} />
              <DetailRow label="Finished" value={formatTimestamp(attempt.finishedAt)} />
              <DetailRow
                label="Duration"
                value={formatDuration(attempt.startedAt, attempt.finishedAt)}
              />
            </section>

            <OpenSessionSection attempt={attempt} />

            {attempt.summary || attempt.errorMessage ? (
              <section className="border border-border/70 bg-background/70 px-4 py-3">
                <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
                  Summary
                </p>
                <p className="mt-2 text-sm leading-7 whitespace-pre-wrap text-foreground">
                  {attempt.summary || attempt.errorMessage}
                </p>
              </section>
            ) : null}

            <Tabs
              value={detailTab}
              onValueChange={(value) => setDetailTab(value as AttemptDetailTab)}
              className="min-h-0"
            >
              <TabsList className="w-full justify-start" variant="line">
                <TabsTrigger value="events">Events</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
              </TabsList>

              <TabsContent value="events" className="mt-4">
                <EventsPanel events={events} />
              </TabsContent>
              <TabsContent value="logs" className="mt-4">
                <AttemptLogPanel attempt={attempt} />
              </TabsContent>
              <TabsContent value="artifacts" className="mt-4">
                <ArtifactsPanel artifacts={artifacts} />
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </div>
    </SheetContent>
  )
}
