import {
  flexRender,
  type Table as TanStackTable,
} from "@tanstack/react-table"

import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type DataTableProps<TData> = {
  emptyMessage: string
  error?: unknown
  isError?: boolean
  isLoading?: boolean
  loadingRowCount?: number
  table: TanStackTable<TData>
}

export function DataTable<TData>({
  emptyMessage,
  error,
  isError = false,
  isLoading = false,
  loadingRowCount = 6,
  table,
}: DataTableProps<TData>) {
  const columns = table.getVisibleLeafColumns()
  const columnCount = Math.max(columns.length, 1)
  const rows = table.getRowModel().rows

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow className="hover:bg-transparent" key={headerGroup.id}>
            {headerGroup.headers.map((header, index) => (
              <TableHead
                className={[
                  index === 0 ? "pl-4" : "",
                  index === headerGroup.headers.length - 1 ? "pr-4" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={header.id}
              >
                {header.isPlaceholder
                  ? null
                  : flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {isLoading ? (
          Array.from({ length: loadingRowCount }, (_, index) => (
            <TableRow key={`loading-row-${index}`}>
              {Array.from({ length: columnCount }, (_column, columnIndex) => (
                <TableCell
                  className={[
                    columnIndex === 0 ? "pl-4" : "",
                    columnIndex === columnCount - 1 ? "pr-4" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={`loading-cell-${index}-${columnIndex}`}
                >
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : isError ? (
          <TableRow>
            <TableCell className="px-4 py-6 text-sm text-rose-700 dark:text-rose-300" colSpan={columnCount}>
              {error instanceof Error ? error.message : "Failed to load records."}
            </TableCell>
          </TableRow>
        ) : rows.length === 0 ? (
          <TableRow>
            <TableCell className="px-4 py-6 text-sm text-muted-foreground" colSpan={columnCount}>
              {emptyMessage}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell, index) => (
                <TableCell
                  className={[
                    index === 0 ? "pl-4" : "",
                    index === row.getVisibleCells().length - 1 ? "pr-4" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={cell.id}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}
