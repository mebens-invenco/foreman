import { useNavigate } from "react-router"

import type { AttemptRecord } from "@/lib/api"
import { formatActionLabel, formatRelativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"

import { useAttemptsQuery } from "@/hooks/use-attempts-query"
import { Skeleton } from "@/components/ui/skeleton"
import { TaskLink } from "@/components/task-link"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatStatusLabel, statusTone } from "@/lib/attempt-status"

function workItemLabel(attempt: AttemptRecord) {
  return attempt.jobKind === "cron" ? attempt.cronJobId ?? "-" : attempt.taskId ?? "-"
}

function targetLabel(attempt: AttemptRecord) {
  return attempt.jobKind === "cron" ? "Workspace" : attempt.target ?? "-"
}

function timestampLabel(attempt: AttemptRecord, now: number) {
  return formatRelativeTime(attempt.finishedAt ?? attempt.startedAt, now)
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
  const navigate = useNavigate()
  const { data: attempts = [], isLoading, isError, error } = useAttemptsQuery({ limit: 12 })
  const openAttempt = (attemptId: string) => {
    navigate(`/attempts?attemptId=${encodeURIComponent(attemptId)}`)
  }

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
            <col className="w-44" />
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
            {attempts.map((attempt) => {
              const workItem = workItemLabel(attempt)
              const target = targetLabel(attempt)
              const stage = formatActionLabel(attempt.stage)
              const summary = attempt.summary || attempt.errorMessage || "-"
              return (
                <TableRow
                  key={attempt.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={() => openAttempt(attempt.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      openAttempt(attempt.id)
                    }
                  }}
                >
                  <TableCell className="overflow-hidden px-4 font-mono text-xs text-foreground">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <TaskLink
                          taskUrl={attempt.jobKind === "cron" ? null : attempt.taskUrl}
                          className="block max-w-full truncate"
                        >
                          {workItem}
                        </TaskLink>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6}>{workItem}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="overflow-hidden text-sm text-foreground">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block max-w-full truncate">{target}</span>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6}>{target}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="overflow-hidden text-sm text-foreground">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="block max-w-full truncate">{stage}</span>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6}>{stage}</TooltipContent>
                    </Tooltip>
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
                  <TableCell className="overflow-hidden">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="block max-w-full truncate text-sm text-muted-foreground">
                          {summary}
                        </p>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6} className="max-w-md whitespace-pre-line">
                        {summary}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="px-4 text-right text-xs text-muted-foreground">
                    {timestampLabel(attempt, now)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </TableSectionShell>
  )
}
