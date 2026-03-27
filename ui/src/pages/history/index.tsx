import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table"
import { useHistoryQuery } from "@/hooks/use-history-query"
import {
  getHistoryRepoOptions,
  getHistoryStageOptions,
  historyColumns,
  historyGlobalFilter,
} from "@/pages/history/columns"
import { useHistoryTableState } from "@/pages/history/use-history-table-state"

export function HistoryPage() {
  const { data: records = [], isLoading, isError, error } = useHistoryQuery()
  const tableState = useHistoryTableState()
  const table = useDataTable({
    columns: historyColumns,
    columnFilters: tableState.columnFilters,
    data: records,
    getRowId: (row) => row.stepId,
    globalFilter: tableState.globalFilter,
    globalFilterFn: historyGlobalFilter,
    onGlobalFilterChange: tableState.setGlobalFilter,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    pagination: tableState.pagination,
    sorting: tableState.sorting,
  })
  const repoOptions = getHistoryRepoOptions(records)
  const stageOptions = getHistoryStageOptions(records)

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-3xl tracking-tight text-foreground">Semantic history</h2>
      </header>

      <DataTableShell>
        <DataTableToolbar
          hasActiveFilters={tableState.hasActiveFilters}
          onReset={tableState.resetFilters}
          onSearchChange={tableState.setGlobalFilter}
          searchPlaceholder="Search tasks, stages, targets, and summaries"
          searchValue={tableState.globalFilter}
        >
          <DataTableFilterSelect
            allLabel="All stages"
            label="Stage"
            onValueChange={tableState.setStage}
            options={stageOptions}
            value={tableState.stage}
          />
          <DataTableFilterSelect
            allLabel="All repos"
            label="Repo"
            onValueChange={tableState.setRepo}
            options={repoOptions}
            value={tableState.repo}
          />
        </DataTableToolbar>

        <DataTable
          emptyMessage={
            records.length === 0
              ? "No history records have been written yet."
              : "No history records match the current filters."
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
