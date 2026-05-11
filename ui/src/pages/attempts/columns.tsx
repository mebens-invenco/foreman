import type { ColumnDef, FilterFn } from "@tanstack/react-table"

import {
  DataTableColumnHeader,
  matchesStringFilter,
  type DataTableFilterOption,
} from "@/components/data-table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TaskLink } from "@/components/task-link"
import {
  abbreviateId,
  formatActionLabel,
  formatDuration,
  formatShortNumber,
  formatTimestamp,
} from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AttemptRecord, TokenUsage } from "@/lib/api"

function totalTokens(tokens: TokenUsage | null) {
  if (!tokens) {
    return null
  }

  return tokens.inputTokens + tokens.outputTokens
}

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
    attempt.nativeSessionId ?? "",
    attempt.jobId,
    attempt.jobKind,
    attempt.taskId ?? "",
    attempt.cronJobId ?? "",
    attempt.target ?? "",
    attempt.stage ?? "",
    attempt.workerId ?? "",
    attempt.attemptNumber,
    attempt.status,
    attempt.runnerName,
    attempt.runnerModel,
    attempt.runnerVariant,
    attempt.summary,
    attempt.errorMessage ?? "",
  ]
    .join(" ")
    .toLowerCase()
}

export const attemptFilterOptions: DataTableFilterOption[] =
  attemptStatusValues.map((status) => ({
    label: formatStatusLabel(status),
    value: status,
  }))

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

export const createAttemptColumns = (): ColumnDef<AttemptRecord>[] => [
  {
    accessorKey: "id",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-foreground">
        {abbreviateId(row.original.id)}
      </span>
    ),
    enableGlobalFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Attempt" />
    ),
  },
  {
    accessorKey: "nativeSessionId",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-foreground">
        {abbreviateId(row.original.nativeSessionId)}
      </span>
    ),
    enableGlobalFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Session" />
    ),
  },
  {
    accessorKey: "taskId",
    cell: ({ row }) => (
      <div className="space-y-1">
        <TaskLink
          taskUrl={row.original.jobKind === "cron" ? null : row.original.taskUrl}
          className="block font-mono text-xs text-foreground"
        >
          {row.original.jobKind === "cron"
            ? row.original.cronJobId ?? "-"
            : row.original.taskId ?? "-"}
        </TaskLink>
        {row.original.jobKind === "cron" ? (
          <span className="block text-xxs tracking-[0.18em] text-muted-foreground uppercase">
            Cron
          </span>
        ) : null}
      </div>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Work item" />
    ),
  },
  {
    accessorKey: "target",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">
        {row.original.jobKind === "cron" ? "Workspace" : row.original.target ?? "-"}
      </span>
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
    accessorKey: "runnerName",
    cell: ({ row }) => (
      <span className="text-xs text-foreground uppercase">
        {row.original.runnerName}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Runner" />
    ),
  },
  {
    accessorKey: "status",
    cell: ({ row }) => (
      <span
        className={cn(
          "inline-flex rounded-none border px-2 py-1 text-xxs font-medium tracking-[0.18em] uppercase",
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
        return (
          <span className="text-xs text-muted-foreground">{durationLabel}</span>
        )
      }

      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground">
              {durationLabel}
            </span>
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
    accessorFn: (row) => totalTokens(row.tokensUsed) ?? -1,
    id: "tokens",
    cell: ({ row }) => {
      const total = totalTokens(row.original.tokensUsed)
      const tokens = row.original.tokensUsed
      const tooltip = tokens
        ? [
            `Input: ${formatShortNumber(tokens.inputTokens)}`,
            `Output: ${formatShortNumber(tokens.outputTokens)}`,
            tokens.cacheReadInputTokens !== undefined
              ? `Cache read: ${formatShortNumber(tokens.cacheReadInputTokens)}`
              : null,
            tokens.cacheCreationInputTokens !== undefined
              ? `Cache create: ${formatShortNumber(tokens.cacheCreationInputTokens)}`
              : null,
          ]
            .filter(Boolean)
            .join("\n")
        : null

      const label = (
        <span className="text-xs text-muted-foreground">
          {formatShortNumber(total)}
        </span>
      )

      if (!tooltip) {
        return label
      }

      return (
        <Tooltip>
          <TooltipTrigger asChild>{label}</TooltipTrigger>
          <TooltipContent sideOffset={6} className="whitespace-pre-line">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      )
    },
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Tokens" />
    ),
  },
  {
    accessorKey: "summary",
    cell: ({ row }) => (
      <p
        className="block max-w-60 truncate text-xs text-muted-foreground"
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
