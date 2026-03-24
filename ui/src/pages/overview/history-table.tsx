import type { HistoryRecord } from "@/lib/api"
import { formatRelativeTime } from "@/lib/format"

import { useHistoryQuery } from "@/hooks/use-history-query"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

function displayTarget(record: HistoryRecord) {
  if (record.repos.length === 0) {
    return "-"
  }

  const repoNames = record.repos
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((repo) => {
      const normalized = repo.path.replace(/\\/g, "/")
      const parts = normalized.split("/").filter(Boolean)
      return parts.at(-1) ?? normalized
    })

  return repoNames.join(", ")
}

function TableSectionShell({
  title,
  children,
}: React.ComponentProps<"section"> & { title: string }) {
  return (
    <section className="border border-border/70 bg-card/75">
      <div className="border-b border-border/70 px-4 py-3">
        <p className="text-[10px] tracking-[0.32em] text-muted-foreground uppercase">
          {title}
        </p>
      </div>
      {children}
    </section>
  )
}

export function HistoryTable({ now }: { now: number }) {
  const { data: records = [], isLoading, isError, error } = useHistoryQuery()

  return (
    <TableSectionShell title="Recent History">
      {isLoading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <div className="px-4 py-6 text-sm text-rose-700 dark:text-rose-300">
          {error instanceof Error ? error.message : "Failed to load history."}
        </div>
      ) : records.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No recent history steps recorded yet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">Task</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="px-4 text-right">Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <TableRow key={record.stepId}>
                <TableCell className="px-4 font-mono text-xs text-foreground">
                  {record.issue}
                </TableCell>
                <TableCell className="text-sm text-foreground">
                  {displayTarget(record)}
                </TableCell>
                <TableCell className="text-sm text-foreground">
                  {record.stage}
                </TableCell>
                <TableCell className="max-w-0">
                  <p className="truncate text-sm text-muted-foreground">
                    {record.summary}
                  </p>
                </TableCell>
                <TableCell className="px-4 text-right text-[11px] text-muted-foreground">
                  {formatRelativeTime(record.createdAt, now)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableSectionShell>
  )
}
