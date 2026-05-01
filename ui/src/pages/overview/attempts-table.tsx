import type { AttemptRecord } from "@/lib/api"
import { formatActionLabel, formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"

import { useAttemptsQuery } from "@/hooks/use-attempts-query"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

function workItemLabel(attempt: AttemptRecord) {
  return attempt.jobKind === "cron" ? attempt.cronJobId ?? "-" : attempt.taskId ?? "-"
}

function targetLabel(attempt: AttemptRecord) {
  return attempt.jobKind === "cron" ? "Workspace" : attempt.target ?? "-"
}

function timestampLabel(attempt: AttemptRecord, now: number) {
  return formatRelativeTime(attempt.finishedAt ?? attempt.startedAt, now)
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

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

function TableSectionShell({
  title,
  children,
}: React.ComponentProps<"section"> & { title: string }) {
  return (
    <section className="border border-border/70 bg-card/75">
      <div className="border-b border-border/70 px-4 py-3">
        <p className="text-xxs tracking-[0.32em] text-muted-foreground uppercase">
          {title}
        </p>
      </div>
      {children}
    </section>
  )
}

export function AttemptsTable({ now }: { now: number }) {
  const { data: attempts = [], isLoading, isError, error } = useAttemptsQuery(12)

  return (
    <TableSectionShell title="Recent Attempts">
      {isLoading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <div className="px-4 py-6 text-sm text-rose-700 dark:text-rose-300">
          {error instanceof Error ? error.message : "Failed to load attempts."}
        </div>
      ) : attempts.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No execution attempts recorded yet.
        </div>
      ) : (
        <Table className="w-full table-fixed">
          <colgroup>
            <col className="w-28" />
            <col className="w-32" />
            <col className="w-28" />
            <col className="w-28" />
            <col />
            <col className="w-24" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">Work item</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="px-4 text-right">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attempts.map((attempt) => (
              <TableRow key={attempt.id}>
                <TableCell className="px-4 font-mono text-xs text-foreground">
                  {workItemLabel(attempt)}
                </TableCell>
                <TableCell className="text-sm text-foreground">
                  {targetLabel(attempt)}
                </TableCell>
                <TableCell className="text-sm text-foreground">
                  {formatActionLabel(attempt.stage)}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex rounded-none border px-2 py-1 text-xxs font-medium tracking-[0.18em] uppercase",
                      statusTone(attempt.status)
                    )}
                  >
                    {formatStatusLabel(attempt.status)}
                  </span>
                </TableCell>
                <TableCell>
                  <p
                    className="block max-w-full truncate text-sm text-muted-foreground"
                    title={attempt.summary || attempt.errorMessage || "-"}
                  >
                    {attempt.summary || attempt.errorMessage || "-"}
                  </p>
                </TableCell>
                <TableCell className="px-4 text-right text-xs text-muted-foreground">
                  {timestampLabel(attempt, now)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableSectionShell>
  )
}
