import type { ColumnDef, FilterFn } from "@tanstack/react-table"

import {
  DataTableColumnHeader,
  matchesStringFilter,
  type DataTableFilterOption,
} from "@/components/data-table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  abbreviateId,
  formatActionLabel,
  formatDuration,
  formatTimestamp,
} from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AttemptRecord } from "@/lib/api"

const attemptStatusValues = [
  "running",
  "completed",
  "failed",
  "blocked",
  "canceled",
  "timed_out",
] as const

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ")
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

function buildAttemptSearchText(attempt: AttemptRecord) {
  return [
    attempt.id,
    attempt.jobId,
    attempt.taskId ?? "",
    attempt.target ?? "",
    attempt.stage ?? "",
    attempt.workerId ?? "",
    attempt.attemptNumber,
    attempt.status,
    attempt.runnerModel,
    attempt.runnerVariant,
    attempt.summary,
    attempt.errorMessage ?? "",
  ]
    .join(" ")
    .toLowerCase()
}

export const attemptFilterOptions: DataTableFilterOption[] = attemptStatusValues.map(
  (status) => ({
    label: formatStatusLabel(status),
    value: status,
  })
)

export const attemptsGlobalFilter: FilterFn<AttemptRecord> = (
  row,
  _columnId,
  filterValue
) => {
  const search = String(filterValue).trim().toLowerCase()
  if (!search) {
    return true
  }

  return buildAttemptSearchText(row.original).includes(search)
}

export const attemptColumns: ColumnDef<AttemptRecord>[] = [
  {
    accessorKey: "id",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-foreground">{abbreviateId(row.original.id)}</span>
    ),
    enableGlobalFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Attempt" />
    ),
  },
  {
    accessorKey: "taskId",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-foreground">
        {row.original.taskId ?? "-"}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Task" />
    ),
  },
  {
    accessorKey: "target",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">{row.original.target ?? "-"}</span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Target" />
    ),
  },
  {
    accessorKey: "stage",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">
        {formatActionLabel(row.original.stage)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Stage" />
    ),
  },
  {
    accessorKey: "status",
    cell: ({ row }) => (
      <span
        className={cn(
          "inline-flex rounded-none border px-2 py-1 text-xxs font-medium uppercase tracking-[0.18em]",
          statusTone(row.original.status)
        )}
      >
        {formatStatusLabel(row.original.status)}
      </span>
    ),
    enableGlobalFilter: false,
    filterFn: matchesStringFilter,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Status" />
    ),
  },
  {
    accessorKey: "startedAt",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">
        {formatTimestamp(row.original.startedAt)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Started" />
    ),
  },
  {
    accessorFn: (row) => {
      if (!row.startedAt || !row.finishedAt) {
        return -1
      }

      const start = new Date(row.startedAt).getTime()
      const end = new Date(row.finishedAt).getTime()
      if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        return -1
      }

      return end - start
    },
    id: "duration",
    cell: ({ row }) => {
      const durationLabel = formatDuration(
        row.original.startedAt,
        row.original.finishedAt
      )

      if (!row.original.finishedAt) {
        return <span className="text-xs text-muted-foreground">{durationLabel}</span>
      }

      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground">{durationLabel}</span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>
            Finished {formatTimestamp(row.original.finishedAt)}
          </TooltipContent>
        </Tooltip>
      )
    },
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Duration" />
    ),
  },
  {
    accessorKey: "summary",
    cell: ({ row }) => (
      <p
        className="block max-w-[32rem] truncate text-xs text-muted-foreground"
        title={row.original.summary || row.original.errorMessage || "-"}
      >
        {row.original.summary || row.original.errorMessage || "-"}
      </p>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Summary" />
    ),
  },
]

export const attemptStatusFilterValues = [
  "all",
  ...attemptStatusValues,
] as const
