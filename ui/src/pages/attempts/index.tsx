import { useState } from "react"

import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table"
import { Sheet } from "@/components/ui/sheet"
import { useAttemptsQuery } from "@/hooks/use-attempts-query"
import {
  attemptFilterOptions,
  attemptsGlobalFilter,
  createAttemptColumns,
} from "@/pages/attempts/columns"
import { AttemptDetailSheet } from "@/pages/attempts/attempt-detail-sheet"
import { useAttemptsTableState } from "@/pages/attempts/use-attempts-table-state"

export function AttemptsPage() {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const { data: attempts = [], isLoading, isError, error } = useAttemptsQuery()
  const tableState = useAttemptsTableState()
  const table = useDataTable({
    columns: createAttemptColumns(),
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
    <>
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
            onRowClick={(attempt) => setSelectedAttemptId(attempt.id)}
            table={table}
          />

          <DataTablePagination table={table} />
        </DataTableShell>
      </div>

      <Sheet
        open={selectedAttemptId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedAttemptId(null)
          }
        }}
      >
        <AttemptDetailSheet attemptId={selectedAttemptId} />
      </Sheet>
    </>
  )
}
