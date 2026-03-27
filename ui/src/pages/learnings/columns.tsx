import type { ColumnDef, FilterFn } from "@tanstack/react-table"

import {
  DataTableColumnHeader,
  matchesStringFilter,
  type DataTableFilterOption,
} from "@/components/data-table"
import { formatTimestamp } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { LearningRecord } from "@/lib/api"

const confidenceValues = ["emerging", "established", "proven"] as const

function confidenceTone(confidence: LearningRecord["confidence"]) {
  switch (confidence) {
    case "proven":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "established":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
    default:
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }
}

function buildLearningSearchText(learning: LearningRecord) {
  return [
    learning.id,
    learning.title,
    learning.repo,
    learning.confidence,
    learning.tags.join(" "),
    learning.content,
  ]
    .join(" ")
    .toLowerCase()
}

export function getLearningRepoOptions(
  learnings: LearningRecord[]
): DataTableFilterOption[] {
  return Array.from(new Set(learnings.map((learning) => learning.repo)))
    .sort((left, right) => left.localeCompare(right))
    .map((repo) => ({
      label: repo,
      value: repo,
    }))
}

export const learningConfidenceOptions: DataTableFilterOption[] =
  confidenceValues.map((confidence) => ({
    label: confidence,
    value: confidence,
  }))

export const learningsGlobalFilter: FilterFn<LearningRecord> = (
  row,
  _columnId,
  filterValue
) => {
  const search = String(filterValue).trim().toLowerCase()
  if (!search) {
    return true
  }

  return buildLearningSearchText(row.original).includes(search)
}

export const learningColumns: ColumnDef<LearningRecord>[] = [
  {
    accessorKey: "title",
    cell: ({ row }) => (
      <div className="space-y-1 whitespace-normal">
        <p className="text-xs text-foreground">{row.original.title}</p>
        <p className="font-mono text-xs text-muted-foreground">{row.original.id}</p>
      </div>
    ),
    enableGlobalFilter: true,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Title" />
    ),
  },
  {
    accessorKey: "repo",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">{row.original.repo}</span>
    ),
    enableGlobalFilter: false,
    filterFn: matchesStringFilter,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Repo" />
    ),
  },
  {
    accessorKey: "confidence",
    cell: ({ row }) => (
      <span
        className={cn(
          "inline-flex rounded-none border px-2 py-1 text-xxs font-medium uppercase tracking-[0.18em]",
          confidenceTone(row.original.confidence)
        )}
      >
        {row.original.confidence}
      </span>
    ),
    enableGlobalFilter: false,
    filterFn: matchesStringFilter,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Confidence" />
    ),
  },
  {
    accessorFn: (row) => row.tags.join(", "),
    id: "tags",
    cell: ({ row }) => (
      <p className="max-w-64 whitespace-normal text-xs text-muted-foreground">
        {row.original.tags.length > 0 ? row.original.tags.join(", ") : "-"}
      </p>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Tags" />
    ),
  },
  {
    accessorKey: "content",
    cell: ({ row }) => (
      <p className="max-w-[32rem] whitespace-normal text-xs leading-6 text-muted-foreground">
        {row.original.content}
      </p>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Learning" />
    ),
  },
  {
    accessorKey: "appliedCount",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">{row.original.appliedCount}</span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Applied" />
    ),
  },
  {
    accessorKey: "readCount",
    cell: ({ row }) => (
      <span className="text-xs text-foreground">{row.original.readCount}</span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Reads" />
    ),
  },
  {
    accessorKey: "updatedAt",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatTimestamp(row.original.updatedAt)}
      </span>
    ),
    enableGlobalFilter: false,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Updated" />
    ),
  },
]

export const learningConfidenceFilterValues = [
  "all",
  ...confidenceValues,
] as const
