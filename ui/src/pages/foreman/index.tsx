import { useMemo } from "react"

import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
  type DataTableFilterOption,
} from "@/components/data-table"
import { useForemanTasksQuery } from "@/hooks/use-foreman-tasks-query"
import { useSettingsQuery } from "@/hooks/use-settings-query"
import {
  createForemanColumns,
  foremanGlobalFilter,
} from "@/pages/foreman/columns"
import {
  agentLabelsOf,
  foremanFrontmatterOptions,
  foremanOnOffOptions,
  isInForemanScope,
  matchesFrontmatterFilter,
  matchesOnOffFilter,
  UNASSIGNED_VALUE,
} from "@/pages/foreman/foreman-helpers"
import { useForemanTableState } from "@/pages/foreman/use-foreman-table-state"

export function ForemanPage() {
  const tableState = useForemanTableState()
  const settingsQuery = useSettingsQuery()
  // Memoize so the `?? []` fallback keeps a stable reference across renders —
  // it feeds several useMemo dependency arrays below.
  const settingsData = settingsQuery.data
  const includeLabels = useMemo(
    () => settingsData?.config.taskSystem.linear?.includeLabels ?? [],
    [settingsData]
  )

  const query = useForemanTasksQuery()
  const { isLoading, isError, error } = query
  const tasks = useMemo(() => query.data ?? [], [query.data])

  // The union the manager lists — ready-state OR agent-tagged.
  const scopedTasks = useMemo(
    () => tasks.filter((task) => isInForemanScope(task, includeLabels)),
    [tasks, includeLabels]
  )

  const filteredTasks = useMemo(
    () =>
      scopedTasks.filter(
        (task) =>
          matchesOnOffFilter(task, tableState.onoff) &&
          matchesFrontmatterFilter(task, tableState.frontmatter) &&
          (tableState.agent === "all" ||
            task.labels.includes(tableState.agent)) &&
          (tableState.assignee === "all" ||
            (task.assignee ?? UNASSIGNED_VALUE) === tableState.assignee)
      ),
    [
      scopedTasks,
      tableState.onoff,
      tableState.frontmatter,
      tableState.agent,
      tableState.assignee,
    ]
  )

  const agentOptions = useMemo<DataTableFilterOption[]>(() => {
    const labels = new Set<string>()
    for (const task of scopedTasks) {
      for (const label of agentLabelsOf(task, includeLabels)) {
        labels.add(label)
      }
    }
    return [...labels]
      .sort()
      .map((label) => ({ label, value: label }))
  }, [scopedTasks, includeLabels])

  const assigneeOptions = useMemo<DataTableFilterOption[]>(() => {
    const assignees = new Set<string>()
    let hasUnassigned = false
    for (const task of scopedTasks) {
      if (task.assignee) {
        assignees.add(task.assignee)
      } else {
        hasUnassigned = true
      }
    }
    const options = [...assignees]
      .sort()
      .map((assignee) => ({ label: assignee, value: assignee }))
    if (hasUnassigned) {
      options.push({ label: "Unassigned", value: UNASSIGNED_VALUE })
    }
    return options
  }, [scopedTasks])

  const columns = useMemo(
    () => createForemanColumns(includeLabels),
    [includeLabels]
  )

  const table = useDataTable({
    columns,
    data: filteredTasks,
    getRowId: (row) => row.id,
    globalFilter: tableState.globalFilter,
    globalFilterFn: foremanGlobalFilter,
    onGlobalFilterChange: tableState.setGlobalFilter,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    pagination: tableState.pagination,
    sorting: tableState.sorting,
  })

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-2">
        <h2 className="text-3xl tracking-tight text-foreground">Foreman</h2>
        <p className="text-sm text-muted-foreground">
          Every issue Foreman watches — ready-state or agent-tagged. Toggle
          whether Foreman may pick up each issue, and spot tagged issues whose
          metadata can&apos;t actually run. Disabling only stops future
          scheduling; a running attempt continues until stopped.
        </p>
      </header>

      <DataTableShell>
        <DataTableToolbar
          hasActiveFilters={tableState.hasActiveFilters}
          onReset={tableState.resetFilters}
          onSearchChange={tableState.setGlobalFilter}
          searchPlaceholder="Search by ticket or title"
          searchValue={tableState.globalFilter}
        >
          <DataTableFilterSelect
            allLabel="All agents"
            label="Agent"
            onValueChange={tableState.setAgent}
            options={agentOptions}
            value={tableState.agent}
          />
          <DataTableFilterSelect
            allLabel="All assignees"
            label="Assignee"
            onValueChange={tableState.setAssignee}
            options={assigneeOptions}
            value={tableState.assignee}
          />
          <DataTableFilterSelect
            allLabel="All Foreman"
            label="Foreman on/off"
            onValueChange={tableState.setOnOff}
            options={foremanOnOffOptions}
            value={tableState.onoff}
          />
          <DataTableFilterSelect
            allLabel="All frontmatter"
            label="Frontmatter"
            onValueChange={tableState.setFrontmatter}
            options={foremanFrontmatterOptions}
            value={tableState.frontmatter}
          />
        </DataTableToolbar>

        <DataTable
          emptyMessage={
            scopedTasks.length === 0
              ? "No issues in Foreman's scope yet."
              : "No issues match the current filters."
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
