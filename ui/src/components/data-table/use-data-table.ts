import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type FilterFn,
  type OnChangeFn,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table"

type UseDataTableProps<TData> = {
  columns: ColumnDef<TData, unknown>[]
  columnFilters?: ColumnFiltersState
  data: TData[]
  getRowId?: (originalRow: TData, index: number) => string
  globalFilter: string
  globalFilterFn?: FilterFn<TData>
  onGlobalFilterChange: OnChangeFn<string>
  onPaginationChange: OnChangeFn<PaginationState>
  onSortingChange: OnChangeFn<SortingState>
  pagination: PaginationState
  sorting: SortingState
}

export function useDataTable<TData>({
  columns,
  columnFilters = [],
  data,
  getRowId,
  globalFilter,
  globalFilterFn,
  onGlobalFilterChange,
  onPaginationChange,
  onSortingChange,
  pagination,
  sorting,
}: UseDataTableProps<TData>) {
  return useReactTable({
    autoResetPageIndex: false,
    columns,
    data,
    enableSortingRemoval: false,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    ...(getRowId ? { getRowId } : {}),
    ...(globalFilterFn ? { globalFilterFn } : {}),
    onGlobalFilterChange,
    onPaginationChange,
    onSortingChange,
    state: {
      columnFilters,
      globalFilter,
      pagination,
      sorting,
    },
  })
}
