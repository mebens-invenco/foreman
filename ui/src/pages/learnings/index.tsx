import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table"
import { useLearningsQuery } from "@/hooks/use-learnings-query"
import {
  getLearningRepoOptions,
  learningColumns,
  learningConfidenceOptions,
  learningsGlobalFilter,
} from "@/pages/learnings/columns"
import { useLearningsTableState } from "@/pages/learnings/use-learnings-table-state"

export function LearningsPage() {
  const { data: learnings = [], isLoading, isError, error } = useLearningsQuery()
  const tableState = useLearningsTableState()
  const table = useDataTable({
    columns: learningColumns,
    columnFilters: tableState.columnFilters,
    data: learnings,
    getRowId: (row) => row.id,
    globalFilter: tableState.globalFilter,
    globalFilterFn: learningsGlobalFilter,
    onGlobalFilterChange: tableState.setGlobalFilter,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    pagination: tableState.pagination,
    sorting: tableState.sorting,
  })
  const repoOptions = getLearningRepoOptions(learnings)

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-3xl tracking-tight text-foreground">Captured learnings</h2>
      </header>

      <DataTableShell>
        <DataTableToolbar
          hasActiveFilters={tableState.hasActiveFilters}
          onReset={tableState.resetFilters}
          onSearchChange={tableState.setGlobalFilter}
          searchPlaceholder="Search learnings by title, repo, tags, and content"
          searchValue={tableState.globalFilter}
        >
          <DataTableFilterSelect
            allLabel="All confidence"
            label="Confidence"
            onValueChange={tableState.setConfidence}
            options={learningConfidenceOptions}
            value={tableState.confidence}
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
            learnings.length === 0
              ? "No learnings have been captured yet."
              : "No learnings match the current filters."
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
