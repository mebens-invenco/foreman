import { useSearchParams } from "react-router"

import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table"
import { Sheet } from "@/components/ui/sheet"
import { useTaskRollupsQuery } from "@/hooks/use-task-rollups-query"
import {
  workItemColumns,
  workItemFilterOptions,
  workItemsGlobalFilter,
} from "@/pages/work-items/columns"
import { useWorkItemsTableState } from "@/pages/work-items/use-work-items-table-state"
import { TaskDetailDrawer } from "@/pages/work-items/task-detail-drawer"
import type { AttemptStatus } from "@/lib/api"

export function WorkItemsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedTaskId = searchParams.get("taskId")
  const tableState = useWorkItemsTableState()
  const queryStatus: AttemptStatus | undefined =
    tableState.status === "all" ? undefined : (tableState.status as AttemptStatus)
  const query = useTaskRollupsQuery({
    search: tableState.globalFilter || undefined,
    status: queryStatus,
  })
  const { data, isLoading, isError, error } = query
  const buckets = data?.buckets ?? []

  const table = useDataTable({
    columns: workItemColumns,
    data: buckets,
    getRowId: (row) => row.taskId,
    globalFilter: tableState.globalFilter,
    globalFilterFn: workItemsGlobalFilter,
    onGlobalFilterChange: tableState.setGlobalFilter,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    pagination: tableState.pagination,
    sorting: tableState.sorting,
  })

  const setSelectedTaskId = (taskId: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (taskId) {
      next.set("taskId", taskId)
    } else {
      next.delete("taskId")
    }
    setSearchParams(next, { replace: true })
  }

  const selectedBucket =
    buckets.find((bucket) => bucket.taskId === selectedTaskId) ?? null

  return (
    <>
      <div className="space-y-4">
        <header className="flex flex-col gap-2">
          <h2 className="text-3xl tracking-tight text-foreground">Work items</h2>
          <p className="text-sm text-muted-foreground">
            One row per ticket. Tokens, cost, and timestamps reflect the selected
            window only — tickets that started before the window will show
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
              options={workItemFilterOptions}
              value={tableState.status}
            />
          </DataTableToolbar>

          <DataTable
            emptyMessage={
              buckets.length === 0
                ? "No work items recorded in this window."
                : "No work items match the current filters."
            }
            error={error}
            isError={isError}
            isLoading={isLoading}
            onRowClick={(bucket) => setSelectedTaskId(bucket.taskId)}
            table={table}
          />

          <DataTablePagination table={table} />
        </DataTableShell>
      </div>

      <Sheet
        open={selectedTaskId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTaskId(null)
          }
        }}
      >
        <TaskDetailDrawer taskId={selectedTaskId} bucket={selectedBucket} />
      </Sheet>
    </>
  )
}
