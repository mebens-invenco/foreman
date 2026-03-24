import { useState } from "react"

import type { Worker } from "@/lib/api"
import { formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"

import { Sheet, SheetTrigger } from "@/components/ui/sheet"
import { WorkerDetailSheet } from "@/pages/overview/worker-detail-sheet"
import { WorkerStatusBadge } from "@/pages/overview/worker-status-badge"

function formatActionLabel(action: string) {
  return action.charAt(0).toUpperCase() + action.slice(1)
}

type WorkerCardProps = {
  worker: Worker
  now: number
}

export function WorkerCard({ worker, now }: WorkerCardProps) {
  const [open, setOpen] = useState(false)
  const isActive = worker.currentJob !== null
  const timeLabel = worker.currentAttempt?.startedAt
    ? `Started ${formatRelativeTime(worker.currentAttempt.startedAt, now)}`
    : `Since ${formatRelativeTime(worker.lastHeartbeatAt, now)}`

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-pressed={open}
          className={cn(
            "group flex flex-col border bg-card/85 p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card hover:shadow-[0_18px_40px_rgba(15,23,42,0.08)] focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none",
            open
              ? "border-primary/55 bg-card shadow-[0_18px_40px_rgba(15,23,42,0.08)]"
              : "border-border/70"
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <p className="text-[10px] tracking-[0.32em] text-muted-foreground uppercase">
              Worker {worker.slot}
            </p>
            <WorkerStatusBadge status={worker.status} />
          </div>

          <div className="flex-1 space-y-5">
            {isActive ? (
              <>
                <p className="mt-2 tracking-tight text-foreground">
                  {worker.currentJob
                    ? formatActionLabel(worker.currentJob.action)
                    : null}
                </p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-[10px] tracking-[0.28em] text-muted-foreground uppercase">
                      Task
                    </p>
                    <p className="mt-2 font-mono text-sm leading-6 break-all text-foreground">
                      {worker.currentJob?.taskId}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] tracking-[0.28em] text-muted-foreground uppercase">
                      Repo
                    </p>
                    <p className="mt-2 text-sm leading-6 break-all text-foreground">
                      {worker.currentJob?.repoKey}
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <p className="mt-2 tracking-tight text-foreground">Idle</p>
            )}
          </div>

          <div className="mt-6 border-t border-border/70 pt-4 text-sm text-muted-foreground">
            {timeLabel}
          </div>
        </button>
      </SheetTrigger>

      <WorkerDetailSheet worker={worker} now={now} />
    </Sheet>
  )
}
