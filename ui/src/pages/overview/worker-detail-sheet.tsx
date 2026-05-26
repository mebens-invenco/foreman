import type { ReactNode } from "react"

import { AttemptStatusSummary } from "@/components/attempt-status-summary"
import { Button } from "@/components/ui/button"
import { useStopAttemptMutation } from "@/hooks/use-attempts-query"
import { useWorkerStatusQuery } from "@/hooks/use-attempt-status-query"
import type { Worker } from "@/lib/api"
import { formatActionLabel, formatRelativeTime, formatTimestamp } from "@/lib/format"

import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { TaskLink } from "@/components/task-link"
import { WorkerLogStream } from "@/pages/overview/worker-log-stream"
import { WorkerStatusBadge } from "@/pages/overview/worker-status-badge"

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

type WorkerDetailSheetProps = {
  worker: Worker
  now: number
}

export function WorkerDetailSheet({ worker, now }: WorkerDetailSheetProps) {
  const stopAttemptMutation = useStopAttemptMutation()
  const workerStatusQuery = useWorkerStatusQuery(worker.id, {
    refetchInterval: worker.currentAttemptId ? 5_000 : false,
  })
  const snapshot = workerStatusQuery.data?.snapshot ?? worker.currentAttemptStatus ?? null
  const timingLabel = worker.currentAttempt?.startedAt
    ? `Started ${formatRelativeTime(worker.currentAttempt.startedAt, now)}`
    : `Idle since ${formatRelativeTime(worker.lastHeartbeatAt, now)}`
  const isCronJob = worker.currentJob?.jobKind === "cron"
  const workItemLabel = isCronJob ? "Cron job" : "Task"
  const workItemValue = isCronJob
    ? worker.currentJob?.cronJobId
    : worker.currentJob?.taskId
  const taskUrl = isCronJob ? null : worker.currentJob?.taskUrl ?? null
  const targetLabel = isCronJob ? "Scope" : "Repo target"
  const targetValue = isCronJob ? "Workspace" : worker.currentJob?.repoKey
  const currentAttemptId = worker.currentAttempt?.id ?? worker.currentAttemptId
  const canStopAttempt = Boolean(
    currentAttemptId && worker.currentAttempt?.status === "running"
  )
  const isStopPending = stopAttemptMutation.isPending
  const isStopDisabled = isStopPending || worker.status === "stopping"
  const stopButtonLabel =
    isStopPending || worker.status === "stopping" ? "Stopping" : "Stop"

  return (
    <SheetContent
      side="right"
      className="data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:w-[min(60rem,calc(100vw-2rem))] data-[side=right]:sm:max-w-[min(60rem,calc(100vw-2rem))] data-[side=right]:xl:w-[min(72rem,calc(100vw-4rem))] data-[side=right]:xl:max-w-[min(72rem,calc(100vw-4rem))]"
    >
      <SheetHeader className="border-b border-border/70 pr-12">
        <div className="flex items-start justify-between gap-4">
          <div>
            <SheetTitle>{`Worker ${worker.slot}`}</SheetTitle>
            <SheetDescription className="mt-2 font-mono text-xs text-muted-foreground">
              {worker.id}
            </SheetDescription>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canStopAttempt ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isStopDisabled}
                onClick={() => {
                  if (currentAttemptId) {
                    stopAttemptMutation.mutate(currentAttemptId)
                  }
                }}
              >
                {stopButtonLabel}
              </Button>
            ) : null}
            <WorkerStatusBadge status={worker.status} />
          </div>
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DetailRow
            label="Activity"
            value={worker.currentJob ? formatActionLabel(worker.currentJob.action) : "Idle"}
          />
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
          <DetailRow
            label={targetLabel}
            value={targetValue ?? "-"}
          />
          <DetailRow
            label="Attempt"
            value={worker.currentAttempt?.id ?? worker.currentAttemptId ?? "-"}
          />
          <DetailRow
            label="Heartbeat"
            value={formatTimestamp(worker.lastHeartbeatAt)}
          />
          <DetailRow label="Timing" value={timingLabel} />
        </section>

        <section className="space-y-3">
          <p className="text-xxs tracking-[0.32em] text-muted-foreground uppercase">
            Deterministic status
          </p>
          <div className="border border-border/70 bg-background/70 p-4">
            <AttemptStatusSummary
              snapshot={snapshot}
              isLoading={workerStatusQuery.isLoading && snapshot === null}
              isError={workerStatusQuery.isError}
              error={workerStatusQuery.error}
              now={now}
              emptyCopy={
                worker.currentAttemptId
                  ? "Awaiting first activity."
                  : "Worker is idle."
              }
            />
          </div>
        </section>

        <section className="space-y-3">
          <p className="text-xxs tracking-[0.32em] text-muted-foreground uppercase">
            Logs
          </p>
          <WorkerLogStream worker={worker} />
        </section>
      </div>
    </SheetContent>
  )
}
