import type { Worker } from "@/lib/api"
import { formatRelativeTime, formatTimestamp } from "@/lib/format"

import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { WorkerLogStream } from "@/pages/overview/worker-log-stream"
import { WorkerStatusBadge } from "@/pages/overview/worker-status-badge"

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border/70 bg-background/70 px-4 py-3">
      <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-2 text-sm leading-6 break-all text-foreground">
        {value}
      </p>
    </div>
  )
}

type WorkerDetailSheetProps = {
  worker: Worker
  now: number
}

export function WorkerDetailSheet({ worker, now }: WorkerDetailSheetProps) {
  const timingLabel = worker.currentAttempt?.startedAt
    ? `Started ${formatRelativeTime(worker.currentAttempt.startedAt, now)}`
    : `Idle since ${formatRelativeTime(worker.lastHeartbeatAt, now)}`

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
          <WorkerStatusBadge status={worker.status} />
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 md:p-6">
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DetailRow
            label="Activity"
            value={worker.currentJob?.action ?? "Idle"}
          />
          <DetailRow label="Task" value={worker.currentJob?.taskId ?? "-"} />
          <DetailRow
            label="Repo target"
            value={worker.currentJob?.repoKey ?? "-"}
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
            Logs
          </p>
          <WorkerLogStream worker={worker} />
        </section>
      </div>
    </SheetContent>
  )
}
