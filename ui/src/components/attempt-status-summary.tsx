import type { ReactNode } from "react"

import type {
  AttemptStatusPhase,
  AttemptStatusSnapshot,
} from "@/lib/api"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"

import { Skeleton } from "@/components/ui/skeleton"

export const phaseToneClass: Record<AttemptStatusPhase, string> = {
  progressing:
    "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  starting:
    "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  suspicious:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  stuck:
    "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  needs_human:
    "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  finished:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  not_started:
    "border-slate-500/25 bg-slate-500/8 text-slate-700 dark:text-slate-300",
}

const phaseLabels: Record<AttemptStatusPhase, string> = {
  progressing: "Progressing",
  starting: "Starting",
  suspicious: "Suspicious",
  stuck: "Stuck",
  needs_human: "Needs human",
  finished: "Finished",
  not_started: "Not started",
}

export function formatPhaseLabel(phase: AttemptStatusPhase) {
  return phaseLabels[phase]
}

function formatStuckSince(seconds: number | null) {
  if (seconds === null) {
    return null
  }

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const remainder = seconds % 60
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainderMinutes = minutes % 60
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`
}

function stuckBadgeLabel(snapshot: AttemptStatusSnapshot) {
  if (snapshot.needsHuman.isNeeded) {
    return "Needs human"
  }
  if (snapshot.stuck.isStuck) {
    const since = formatStuckSince(snapshot.stuck.sinceSeconds)
    return since ? `Stuck ${since}` : "Stuck"
  }
  if (snapshot.phase === "suspicious") {
    return "Suspicious"
  }
  return null
}

export function AttemptPhaseBadge({
  phase,
  className,
}: {
  phase: AttemptStatusPhase
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-none border px-2 py-1 text-xxs font-medium uppercase tracking-[0.24em]",
        phaseToneClass[phase],
        className,
      )}
    >
      {phaseLabels[phase]}
    </span>
  )
}

type AttemptStatusSummaryProps = {
  snapshot: AttemptStatusSnapshot | null
  isLoading?: boolean
  isError?: boolean
  error?: unknown
  /**
   * "card" — used inside worker cards / overview tiles. Title is hidden.
   * "row" — used inline in tables. Single-line, no description.
   * "panel" — used in detail sheets. Full description and chip list visible.
   */
  variant?: "card" | "row" | "panel"
  /** Render time-ago strings against this clock instead of Date.now(). */
  now?: number
  /** Optional empty-state copy when snapshot resolves to null but no error. */
  emptyCopy?: string
}

function StatusChip({
  label,
  tone,
}: {
  label: ReactNode
  tone: "amber" | "rose" | "slate"
}) {
  const toneClass =
    tone === "rose"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      : tone === "amber"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300"

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-none border px-2 py-1 text-xxs font-medium uppercase tracking-[0.18em]",
        toneClass,
      )}
    >
      {label}
    </span>
  )
}

export function AttemptStatusSummary({
  snapshot,
  isLoading,
  isError,
  error,
  variant = "panel",
  now = Date.now(),
  emptyCopy = "Status unavailable.",
}: AttemptStatusSummaryProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-5 w-32" />
        {variant !== "row" ? <Skeleton className="h-4 w-48" /> : null}
      </div>
    )
  }

  if (isError) {
    return (
      <p className="text-xs text-rose-700 dark:text-rose-300">
        {error instanceof Error ? error.message : "Failed to load status."}
      </p>
    )
  }

  if (!snapshot) {
    return <p className="text-xs text-muted-foreground">{emptyCopy}</p>
  }

  const stuckLabel = stuckBadgeLabel(snapshot)
  const operationLabel = snapshot.currentOperation?.message ?? null
  const latestMeaningfulAt = snapshot.progressSummary.latestMeaningfulAt
  const latestMeaningfulMessage = snapshot.progressSummary.latestMeaningfulMessage
  const lastProgressLine = latestMeaningfulAt
    ? `Last progress ${formatRelativeTime(latestMeaningfulAt, now)}`
    : "No meaningful progress yet"

  if (variant === "row") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <AttemptPhaseBadge phase={snapshot.phase} />
        {stuckLabel ? (
          <StatusChip label={stuckLabel} tone={snapshot.needsHuman.isNeeded || snapshot.stuck.isStuck ? "rose" : "amber"} />
        ) : null}
        <span className="text-xxs text-muted-foreground">
          {lastProgressLine}
        </span>
      </div>
    )
  }

  if (variant === "card") {
    return (
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <AttemptPhaseBadge phase={snapshot.phase} />
          {stuckLabel ? (
            <StatusChip label={stuckLabel} tone={snapshot.needsHuman.isNeeded || snapshot.stuck.isStuck ? "rose" : "amber"} />
          ) : null}
        </div>
        {operationLabel ? (
          <p className="truncate text-xs text-foreground">{operationLabel}</p>
        ) : null}
        <p className="truncate text-xxs text-muted-foreground">
          {lastProgressLine}
        </p>
      </div>
    )
  }

  const reasons = snapshot.needsHuman.reasons
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <AttemptPhaseBadge phase={snapshot.phase} />
        {stuckLabel ? (
          <StatusChip label={stuckLabel} tone={snapshot.needsHuman.isNeeded || snapshot.stuck.isStuck ? "rose" : "amber"} />
        ) : null}
        <span className="text-xxs text-muted-foreground">
          {`${snapshot.counts.activities} activities`}
        </span>
      </div>

      {operationLabel ? (
        <div>
          <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
            Current operation
          </p>
          <p className="mt-1 break-all text-sm text-foreground">{operationLabel}</p>
          {snapshot.currentOperation?.startedAt ? (
            <p className="mt-1 text-xxs text-muted-foreground">
              Started {formatRelativeTime(snapshot.currentOperation.startedAt, now)}
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
          Progress
        </p>
        <p className="mt-1 text-sm text-foreground">
          {latestMeaningfulMessage ?? "No meaningful progress yet."}
        </p>
        <p className="mt-1 text-xxs text-muted-foreground">
          {lastProgressLine}
        </p>
      </div>

      {reasons.length > 0 ? (
        <div>
          <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
            Needs human
          </p>
          <ul className="mt-1 space-y-1 text-sm text-foreground">
            {reasons.map((reason) => (
              <li key={reason} className="break-all">{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {snapshot.repeatedFailureCandidates.length > 0 ? (
        <div>
          <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
            Repeated failures
          </p>
          <ul className="mt-1 space-y-1 text-sm text-foreground">
            {snapshot.repeatedFailureCandidates.map((candidate) => (
              <li key={candidate.signature} className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs break-all">{candidate.signature}</span>
                <span className="text-xxs text-muted-foreground">
                  {`${candidate.count}x`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
