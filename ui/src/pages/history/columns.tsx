import type { ColumnDef, FilterFn } from "@tanstack/react-table"

import {
  DataTableColumnHeader,
  matchesStringFilter,
  type DataTableFilterOption,
} from "@/components/data-table"
import { formatTimestamp } from "@/lib/format"
import type { HistoryRecord } from "@/lib/api"

export function displayHistoryTarget(record: HistoryRecord) {
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

function buildHistorySearchText(record: HistoryRecord) {
  return [
    record.issue,
    record.stage,
    record.summary,
    displayHistoryTarget(record),
  ]
    .join(" ")
    .toLowerCase()
}

export const historyGlobalFilter: FilterFn<HistoryRecord> = (
  row,
  _columnId,
  filterValue
) => {
  const search = String(filterValue).trim().toLowerCase()
  if (!search) {
    return true
  }

  return buildHistorySearchText(row.original).includes(search)
}

export function getHistoryStageOptions(
  records: HistoryRecord[]
): DataTableFilterOption[] {
  return Array.from(new Set(records.map((record) => record.stage)))
    .sort((left, right) => left.localeCompare(right))
    .map((stage) => ({
      label: stage,
      value: stage,
    }))
}

export function getHistoryRepoOptions(
  records: HistoryRecord[]
): DataTableFilterOption[] {
  return Array.from(
    new Set(
      records.flatMap((record) =>
        displayHistoryTarget(record)
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0 && part !== "-")
      )
    )
  )
    .sort((left, right) => left.localeCompare(right))
    .map((repo) => ({
      label: repo,
      value: repo,
    }))
}

export const historyColumns: ColumnDef<HistoryRecord>[] = [
  {
    accessorKey: "issue",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-foreground">{row.original.issue}</span>
    ),
    enableGlobalFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Task" />
    ),
  },
  {
    accessorFn: displayHistoryTarget,
    id: "target",
    cell: ({ row }) => (
      <span className="whitespace-normal text-xs text-foreground">
        {displayHistoryTarget(row.original)}
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
      <span className="text-xs text-foreground">{row.original.stage}</span>
    ),
    enableGlobalFilter: false,
    filterFn: matchesStringFilter,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Stage" />
    ),
  },
  {
    accessorKey: "summary",
    cell: ({ row }) => (
      <p className="max-w-[36rem] whitespace-normal text-xs leading-6 text-muted-foreground">
        {row.original.summary || "-"}
      </p>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Summary" />
    ),
  },
  {
    accessorKey: "createdAt",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatTimestamp(row.original.createdAt)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Recorded" />
    ),
  },
]
