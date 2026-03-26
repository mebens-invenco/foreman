import type { WorkerStatus } from "@/lib/api"
import { cn } from "@/lib/utils"

const workerStatusTone: Record<WorkerStatus, string> = {
  idle: "border-slate-500/25 bg-slate-500/8 text-slate-700 dark:text-slate-300",
  leased: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  running: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  stopping: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  offline: "border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300",
}

export function WorkerStatusBadge({ status }: { status: WorkerStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-none border px-2 py-1 text-xxs font-medium uppercase tracking-[0.24em]",
        workerStatusTone[status]
      )}
    >
      {status}
    </span>
  )
}
