import type { Table } from "@tanstack/react-table"
import {
  ChevronFirstIcon,
  ChevronLastIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type DataTablePaginationProps<TData> = {
  pageSizeOptions?: number[]
  table: Table<TData>
}

function formatVisibleRows(start: number, end: number, total: number) {
  if (total === 0) {
    return "0 of 0"
  }

  return `${start}-${end} of ${total}`
}

export function DataTablePagination<TData>({
  pageSizeOptions = [10, 25, 50, 100],
  table,
}: DataTablePaginationProps<TData>) {
  const filteredCount = table.getFilteredRowModel().rows.length
  const pageCount = Math.max(table.getPageCount(), 1)
  const pageIndex = table.getState().pagination.pageIndex
  const pageSize = table.getState().pagination.pageSize
  const pageRows = table.getRowModel().rows.length
  const visibleStart = filteredCount === 0 ? 0 : pageIndex * pageSize + 1
  const visibleEnd = filteredCount === 0 ? 0 : visibleStart + pageRows - 1

  return (
    <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="text-xs text-muted-foreground">
        Showing {formatVisibleRows(visibleStart, visibleEnd, filteredCount)}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Rows</span>
          <Select
            onValueChange={(value) => table.setPageSize(Number(value))}
            value={String(pageSize)}
          >
            <SelectTrigger aria-label="Rows per page" className="min-w-16">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="min-w-24 text-center text-xs text-muted-foreground">
          Page {Math.min(pageIndex + 1, pageCount)} of {pageCount}
        </span>

        <div className="flex items-center gap-1">
          <Button
            aria-label="First page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.setPageIndex(0)}
            size="icon"
            variant="outline"
          >
            <ChevronFirstIcon className="size-3" />
          </Button>
          <Button
            aria-label="Previous page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
            size="icon"
            variant="outline"
          >
            <ChevronLeftIcon className="size-3" />
          </Button>
          <Button
            aria-label="Next page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
            size="icon"
            variant="outline"
          >
            <ChevronRightIcon className="size-3" />
          </Button>
          <Button
            aria-label="Last page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.setPageIndex(pageCount - 1)}
            size="icon"
            variant="outline"
          >
            <ChevronLastIcon className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}
