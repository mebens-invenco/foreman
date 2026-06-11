import type { ColumnDef, FilterFn } from "@tanstack/react-table"

import { DataTableColumnHeader } from "@/components/data-table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TaskLink } from "@/components/task-link"
import {
  ForemanToggleCell,
  FrontmatterCell,
} from "@/pages/foreman/foreman-cells"
import type { ForemanTask } from "@/lib/api"

export const foremanGlobalFilter: FilterFn<ForemanTask> = (
  row,
  _columnId,
  filterValue
) => {
  const search = String(filterValue).trim().toLowerCase()
  if (!search) {
    return true
  }
  return (
    row.original.id.toLowerCase().includes(search) ||
    row.original.title.toLowerCase().includes(search)
  )
}

export function createForemanColumns(
  includeLabels: string[]
): ColumnDef<ForemanTask>[] {
  return [
    {
      accessorKey: "id",
      cell: ({ row }) => (
        <TaskLink
          taskUrl={row.original.url}
          className="block max-w-40 truncate font-mono text-xs text-foreground"
        >
          {row.original.id}
        </TaskLink>
      ),
      enableGlobalFilter: true,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Ticket" />
      ),
    },
    {
      accessorKey: "title",
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block max-w-80 truncate text-xs text-foreground">
              {row.original.title}
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6} className="max-w-sm">
            {row.original.title}
          </TooltipContent>
        </Tooltip>
      ),
      enableGlobalFilter: true,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Title" />
      ),
    },
    {
      accessorKey: "providerState",
      cell: ({ row }) => (
        <span className="text-xs text-foreground">{row.original.providerState}</span>
      ),
      enableGlobalFilter: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="State" />
      ),
    },
    {
      id: "assignee",
      accessorFn: (row) => row.assignee ?? "",
      cell: ({ row }) => (
        <span className="text-xs text-foreground">
          {row.original.assignee ?? "—"}
        </span>
      ),
      enableGlobalFilter: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Assignee" />
      ),
    },
    // At-risk column slot — added in a later enhancement ticket; it sits here
    // between Assignee and Frontmatter.
    {
      id: "frontmatter",
      accessorFn: (row) => row.frontmatter.state,
      cell: ({ row }) => (
        <FrontmatterCell includeLabels={includeLabels} task={row.original} />
      ),
      enableGlobalFilter: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Frontmatter" />
      ),
    },
    {
      id: "foreman",
      cell: ({ row }) => (
        <ForemanToggleCell includeLabels={includeLabels} task={row.original} />
      ),
      enableGlobalFilter: false,
      enableSorting: false,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Foreman" />
      ),
    },
  ]
}
