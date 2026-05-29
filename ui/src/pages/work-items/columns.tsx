import type { ColumnDef, FilterFn } from "@tanstack/react-table"

import {
  DataTableColumnHeader,
  type DataTableFilterOption,
} from "@/components/data-table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TaskLink } from "@/components/task-link"
import { formatDuration, formatShortNumber, formatTimestamp } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatUsd, totalAllTokenBuckets } from "@/lib/cost"
import { attemptStatusValues, formatStatusLabel, statusTone } from "@/lib/attempt-status"
import type { WorkItemBucket } from "@/lib/api"

export const workItemStatusFilterValues = [
  "all",
  ...attemptStatusValues,
] as const

export const workItemFilterOptions: DataTableFilterOption[] =
  attemptStatusValues.map((status) => ({
    label: formatStatusLabel(status),
    value: status,
  }))

export const workItemsGlobalFilter: FilterFn<WorkItemBucket> = (
  row,
  _columnId,
  filterValue
) => {
  const search = String(filterValue).trim().toLowerCase()
  if (!search) {
    return true
  }
  return row.original.taskId.toLowerCase().includes(search)
}

const tokensTotal = (tokens: WorkItemBucket["tokens"]): number =>
  totalAllTokenBuckets({
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadInputTokens: tokens.cacheReadInputTokens,
    cacheCreationInputTokens: tokens.cacheCreationInputTokens,
    reasoningOutputTokens: tokens.reasoningOutputTokens,
  }) ?? 0

export const workItemColumns: ColumnDef<WorkItemBucket>[] = [
  {
    accessorKey: "taskId",
    cell: ({ row }) => (
      <TaskLink
        taskUrl={row.original.taskUrl}
        className="block max-w-40 truncate font-mono text-xs text-foreground"
      >
        {row.original.taskId}
      </TaskLink>
    ),
    enableGlobalFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Ticket" />
    ),
  },
  {
    id: "targets",
    accessorFn: (row) => row.targets.join(", "),
    cell: ({ row }) => {
      const label = row.original.targets.join(", ") || "-"
      const detail = row.original.perTargetLatestStatus
        .map((entry) => `${entry.target}: ${formatStatusLabel(entry.status)}`)
        .join("\n")
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-40 truncate text-xs text-foreground">
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="whitespace-pre-line">
            {detail || label}
          </TooltipContent>
        </Tooltip>
      )
    },
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Targets" />
    ),
  },
  {
    accessorKey: "attemptsCount",
    cell: ({ row }) => (
      <span className="text-right font-mono text-xs text-foreground">
        {row.original.attemptsCount}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Attempts" />
    ),
  },
  {
    id: "tokens",
    accessorFn: (row) => tokensTotal(row.tokens),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatShortNumber(tokensTotal(row.original.tokens))}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Tokens (all)" />
    ),
  },
  {
    id: "cost",
    accessorFn: (row) => row.cost.totalUsd,
    cell: ({ row }) => (
      <span className="text-xs text-foreground">
        {formatUsd(row.original.cost.totalUsd)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Cost" />
    ),
  },
  {
    accessorKey: "effectiveStatus",
    cell: ({ row }) => (
      <span
        className={cn(
          "inline-flex rounded-none border px-2 py-1 text-xxs font-medium tracking-[0.18em] uppercase",
          statusTone(row.original.effectiveStatus)
        )}
      >
        {formatStatusLabel(row.original.effectiveStatus)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Status" />
    ),
  },
  {
    accessorKey: "firstSeenInWindow",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">
        {formatTimestamp(row.original.firstSeenInWindow)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="First seen (in window)" />
    ),
  },
  {
    id: "span",
    accessorFn: (row) => {
      if (!row.lastFinishedAt) {
        return -1
      }
      const start = new Date(row.firstSeenInWindow).getTime()
      const end = new Date(row.lastFinishedAt).getTime()
      if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        return -1
      }
      return end - start
    },
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatDuration(row.original.firstSeenInWindow, row.original.lastFinishedAt)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Span" />
    ),
  },
]
