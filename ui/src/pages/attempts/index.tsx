import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table"
import { useAttemptsQuery } from "@/hooks/use-attempts-query"
import {
  attemptColumns,
  attemptFilterOptions,
  attemptsGlobalFilter,
} from "@/pages/attempts/columns"
import { useAttemptsTableState } from "@/pages/attempts/use-attempts-table-state"

export function AttemptsPage() {
  const { data: attempts = [], isLoading, isError, error } = useAttemptsQuery()
  const tableState = useAttemptsTableState()
  const table = useDataTable({
    columns: attemptColumns,
    columnFilters: tableState.columnFilters,
    data: attempts,
    getRowId: (row) => row.id,
    globalFilter: tableState.globalFilter,
    globalFilterFn: attemptsGlobalFilter,
    onGlobalFilterChange: tableState.setGlobalFilter,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    pagination: tableState.pagination,
    sorting: tableState.sorting,
  })

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-3xl tracking-tight text-foreground">Execution attempts</h2>
      </header>

      <DataTableShell>
        <DataTableToolbar
          hasActiveFilters={tableState.hasActiveFilters}
          onReset={tableState.resetFilters}
          onSearchChange={tableState.setGlobalFilter}
          searchPlaceholder="Search attempts, tasks, targets, stages, and summaries"
          searchValue={tableState.globalFilter}
        >
          <DataTableFilterSelect
            allLabel="All statuses"
            label="Status"
            onValueChange={tableState.setStatus}
            options={attemptFilterOptions}
            value={tableState.status}
          />
        </DataTableToolbar>

        <DataTable
          emptyMessage={
            attempts.length === 0
              ? "No execution attempts recorded yet."
              : "No attempts match the current filters."
          }
          error={error}
          isError={isError}
          isLoading={isLoading}
          table={table}
        />

        <DataTablePagination table={table} />
      </DataTableShell>
    </div>
  )
}
