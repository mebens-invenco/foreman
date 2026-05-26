import {
  AttemptPhaseBadge,
  AttemptStatusSummary,
} from "@/components/attempt-status-summary"
import { useAttemptStatusQuery } from "@/hooks/use-attempt-status-query"
import type { AttemptRecord, AttemptStatusPhase } from "@/lib/api"

type TerminalAttemptStatus = Exclude<AttemptRecord["status"], "running">

type TerminalBadgeMeta = {
  label: string
  phase: AttemptStatusPhase
}

export const TERMINAL_BADGE: Record<TerminalAttemptStatus, TerminalBadgeMeta> = {
  completed: { label: "Finished", phase: "finished" },
  failed: { label: "Failed", phase: "stuck" },
  blocked: { label: "Blocked", phase: "stuck" },
  canceled: { label: "Canceled", phase: "suspicious" },
  timed_out: { label: "Timed out", phase: "suspicious" },
}

export function terminalAttemptBadge(status: TerminalAttemptStatus): TerminalBadgeMeta {
  return TERMINAL_BADGE[status]
}

type AttemptActivityCellProps = {
  attempt: AttemptRecord
  now: number
}

export function AttemptActivityCell({
  attempt,
  now,
}: AttemptActivityCellProps) {
  const isLive = attempt.status === "running"
  const query = useAttemptStatusQuery(isLive ? attempt.id : null, {
    refetchInterval: isLive ? 5_000 : false,
    enabled: isLive,
  })

  if (!isLive) {
    const meta = terminalAttemptBadge(attempt.status)
    return <AttemptPhaseBadge phase={meta.phase} label={meta.label} />
  }

  return (
    <AttemptStatusSummary
      snapshot={query.data?.snapshot ?? null}
      isLoading={query.isLoading}
      isError={query.isError}
      error={query.error}
      variant="row"
      now={now}
      emptyCopy="Awaiting first activity"
    />
  )
}
