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
import { estimateCost, formatUsd, totalAllTokenBuckets } from "@/lib/cost"
import { formatStatusLabel, statusTone } from "@/lib/attempt-status"
import type { AttemptRecord, UsageRate } from "@/lib/api"

const attemptStatusValues = [
  "running",
  "completed",
  "failed",
  "blocked",
  "canceled",
  "timed_out",
] as const

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

export const createAttemptColumns = (rates: UsageRate[] | undefined): ColumnDef<AttemptRecord>[] => [
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
    cell: ({ row }) => {
      const workItemId =
        row.original.jobKind === "cron"
          ? row.original.cronJobId ?? "-"
          : row.original.taskId ?? "-"
      return (
        <div className="space-y-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <TaskLink
                taskUrl={row.original.jobKind === "cron" ? null : row.original.taskUrl}
                className="block max-w-40 truncate font-mono text-xs text-foreground"
              >
                {workItemId}
              </TaskLink>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{workItemId}</TooltipContent>
          </Tooltip>
          {row.original.jobKind === "cron" ? (
            <span className="block text-xxs tracking-[0.18em] text-muted-foreground uppercase">
              Cron
            </span>
          ) : null}
        </div>
      )
    },
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Work item" />
    ),
  },
  {
    accessorKey: "target",
    cell: ({ row }) => {
      const target =
        row.original.jobKind === "cron" ? "Workspace" : row.original.target ?? "-"
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-40 truncate text-xs text-foreground">
              {target}
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{target}</TooltipContent>
        </Tooltip>
      )
    },
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Target" />
    ),
  },
  {
    accessorKey: "stage",
    cell: ({ row }) => {
      const stage = formatActionLabel(row.original.stage)
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-32 truncate text-xs text-foreground">
              {stage}
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{stage}</TooltipContent>
        </Tooltip>
      )
    },
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
    accessorFn: (row) => totalAllTokenBuckets(row.tokensUsed) ?? -1,
    id: "tokens",
    cell: ({ row }) => {
      const tokens = row.original.tokensUsed
      const total = totalAllTokenBuckets(tokens)
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
            tokens.reasoningOutputTokens !== undefined
              ? `Reasoning: ${formatShortNumber(tokens.reasoningOutputTokens)}`
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
      <DataTableColumnHeader column={column} title="Tokens (all)" />
    ),
  },
  {
    accessorFn: (row) =>
      estimateCost(row.tokensUsed, row.runnerName, row.runnerModel, rates).totalUsd,
    id: "cost",
    cell: ({ row }) => {
      const estimate = estimateCost(
        row.original.tokensUsed,
        row.original.runnerName,
        row.original.runnerModel,
        rates
      )
      const label = (
        <span className="text-xs text-foreground">{formatUsd(estimate.totalUsd)}</span>
      )

      if (!estimate.rateApplied) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground">$0.00</span>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>
              No rate entry for {row.original.runnerName}/{row.original.runnerModel}
            </TooltipContent>
          </Tooltip>
        )
      }

      const tooltip = [
        `Input: ${formatUsd(estimate.breakdown.input)}`,
        `Output: ${formatUsd(estimate.breakdown.output)}`,
        `Cache read: ${formatUsd(estimate.breakdown.cacheRead)}`,
        `Cache write: ${formatUsd(estimate.breakdown.cacheCreate)}`,
        estimate.breakdown.reasoning > 0
          ? `Reasoning: ${formatUsd(estimate.breakdown.reasoning)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")

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
      <DataTableColumnHeader column={column} title="Cost" />
    ),
  },
  {
    accessorKey: "summary",
    cell: ({ row }) => {
      const summary = row.original.summary || row.original.errorMessage || "-"
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="block max-w-60 truncate text-xs text-muted-foreground">
              {summary}
            </p>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="max-w-md whitespace-pre-line">
            {summary}
          </TooltipContent>
        </Tooltip>
      )
    },
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
