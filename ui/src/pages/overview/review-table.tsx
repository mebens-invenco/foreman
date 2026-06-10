import { formatRelativeTime } from "@/lib/format"
import { toReviewRows } from "@/lib/review-rows"

import { useReviewItemsQuery } from "@/hooks/use-review-items-query"
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

function TableSectionShell({
  title,
  children,
}: React.ComponentProps<"section"> & { title: string }) {
  return (
    <section className="border border-border/70 bg-card/75">
      <div className="border-b border-border/70 px-4 py-3">
        <p className="text-xxs uppercase tracking-[0.32em] text-muted-foreground">
          {title}
        </p>
      </div>
      {children}
    </section>
  )
}

export function ReviewTable({ now }: { now: number }) {
  const { data: tasks = [], isLoading, isError, error } = useReviewItemsQuery()
  const rows = toReviewRows(tasks)

  return (
    <TableSectionShell title="Needs Review">
      {isLoading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <div className="px-4 py-6 text-sm text-rose-700 dark:text-rose-300">
          {error instanceof Error ? error.message : "Failed to load review items."}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No pull requests need review right now.
        </div>
      ) : (
        <Table className="w-full min-w-[36rem] table-fixed">
          <colgroup>
            <col className="w-28" />
            <col className="w-44" />
            <col />
            <col className="w-24" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">Task</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Pull Request</TableHead>
              <TableHead className="px-4 text-right">Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.taskId}:${row.target}:${row.pullRequestUrl}`}>
                <TableCell className="overflow-hidden px-4 font-mono text-xs text-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <TaskLink taskUrl={row.taskUrl} className="block max-w-full truncate">
                        {row.taskId}
                      </TaskLink>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{row.taskId}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="overflow-hidden text-sm text-foreground">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block max-w-full truncate">{row.target}</span>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{row.target}</TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="overflow-hidden">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={row.pullRequestUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block max-w-full truncate text-sm text-foreground underline-offset-4 hover:text-primary hover:underline"
                      >
                        {row.pullRequestLabel}
                      </a>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6} className="max-w-md">
                      {row.pullRequestLabel}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell className="px-4 text-right text-xs text-muted-foreground">
                  {formatRelativeTime(row.modifiedAt, now)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableSectionShell>
  )
}
