import { useNavigate } from "react-router"

import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table"
import { useTaskRollupsQuery } from "@/hooks/use-task-rollups-query"
import {
  taskColumns,
  taskFilterOptions,
  tasksGlobalFilter,
} from "@/pages/tasks/columns"
import { useTasksTableState } from "@/pages/tasks/use-tasks-table-state"
import type { AttemptStatus } from "@/lib/api"

export function TasksPage() {
  const navigate = useNavigate()
  const tableState = useTasksTableState()
  const queryStatus: AttemptStatus | undefined =
    tableState.status === "all" ? undefined : (tableState.status as AttemptStatus)
  const query = useTaskRollupsQuery({
    search: tableState.globalFilter || undefined,
    status: queryStatus,
  })
  const { data, isLoading, isError, error } = query
  const buckets = data?.buckets ?? []

  const table = useDataTable({
    columns: taskColumns,
    data: buckets,
    getRowId: (row) => row.taskId,
    globalFilter: tableState.globalFilter,
    globalFilterFn: tasksGlobalFilter,
    onGlobalFilterChange: tableState.setGlobalFilter,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    pagination: tableState.pagination,
    sorting: tableState.sorting,
  })

  const openTaskAttempts = (taskId: string) => {
    navigate(`/attempts?taskId=${encodeURIComponent(taskId)}`)
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-2">
        <h2 className="text-3xl tracking-tight text-foreground">Tasks</h2>
        <p className="text-sm text-muted-foreground">
          One row per task. Tokens, cost, and timestamps reflect the selected
          window only — tasks that started before the window will show
          partial sums.
        </p>
      </header>

      <DataTableShell>
        <DataTableToolbar
          hasActiveFilters={tableState.hasActiveFilters}
          onReset={tableState.resetFilters}
          onSearchChange={tableState.setGlobalFilter}
          searchPlaceholder="Search by ticket ID"
          searchValue={tableState.globalFilter}
        >
          <DataTableFilterSelect
            allLabel="All statuses"
            label="Status"
            onValueChange={tableState.setStatus}
            options={taskFilterOptions}
            value={tableState.status}
          />
        </DataTableToolbar>

        <DataTable
          emptyMessage={
            buckets.length === 0
              ? "No tasks recorded in this window."
              : "No tasks match the current filters."
          }
          error={error}
          isError={isError}
          isLoading={isLoading}
          onRowClick={(bucket) => openTaskAttempts(bucket.taskId)}
          table={table}
        />

        <DataTablePagination table={table} />
      </DataTableShell>
    </div>
  )
}
