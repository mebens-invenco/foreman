import {
  AttemptPhaseBadge,
  AttemptStatusSummary,
} from "@/components/attempt-status-summary"
import { useAttemptStatusQuery } from "@/hooks/use-attempt-status-query"
import type { AttemptRecord } from "@/lib/api"

const RUNNING_STATUSES: ReadonlyArray<AttemptRecord["status"]> = ["running"]

type AttemptActivityCellProps = {
  attempt: AttemptRecord
  now: number
}

export function AttemptActivityCell({
  attempt,
  now,
}: AttemptActivityCellProps) {
  const isLive = RUNNING_STATUSES.includes(attempt.status)
  const query = useAttemptStatusQuery(isLive ? attempt.id : null, {
    refetchInterval: isLive ? 5_000 : false,
    enabled: isLive,
  })

  if (!isLive) {
    return <AttemptPhaseBadge phase="finished" />
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
