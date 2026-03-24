import type { TaskListItem, TaskPullRequest, TaskTargetSummary } from "@/lib/api"
import { formatRelativeTime } from "@/lib/format"

import { useReviewItemsQuery } from "@/hooks/use-review-items-query"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type ReviewRow = {
  taskId: string
  target: string
  pullRequestUrl: string
  pullRequestLabel: string
  modifiedAt: string
}

function findPullRequest(
  task: TaskListItem,
  target: TaskTargetSummary
): TaskPullRequest | null {
  return task.pullRequests.find((pullRequest) => pullRequest.repoKey === target.repoKey) ?? null
}

function toReviewRows(tasks: TaskListItem[]): ReviewRow[] {
  return tasks.flatMap((task) =>
    task.targets
      .filter((target) => target.review?.state === "open")
      .map((target) => {
        const pullRequest = findPullRequest(task, target)
        const pullRequestLabel = pullRequest?.title?.trim()
          ? pullRequest.title
          : `PR #${target.review?.pullRequestNumber ?? "-"}`

        return {
          taskId: task.id,
          target: target.repoKey,
          pullRequestUrl: target.review?.pullRequestUrl ?? pullRequest?.url ?? "",
          pullRequestLabel,
          modifiedAt: task.updatedAt,
        }
      })
  )
}

function TableSectionShell({
  title,
  children,
}: React.ComponentProps<"section"> & { title: string }) {
  return (
    <section className="border border-border/70 bg-card/75">
      <div className="border-b border-border/70 px-4 py-3">
        <p className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
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
        <Table>
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
                <TableCell className="px-4 font-mono text-xs text-foreground">
                  {row.taskId}
                </TableCell>
                <TableCell className="text-sm text-foreground">
                  {row.target}
                </TableCell>
                <TableCell className="max-w-0">
                  <a
                    href={row.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate text-sm text-foreground underline-offset-4 hover:text-primary hover:underline"
                  >
                    {row.pullRequestLabel}
                  </a>
                </TableCell>
                <TableCell className="px-4 text-right text-[11px] text-muted-foreground">
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
