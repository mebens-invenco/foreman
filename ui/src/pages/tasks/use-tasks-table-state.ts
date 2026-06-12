import { parseAsStringLiteral, useQueryStates } from "nuqs"

import { useDataTableState } from "@/components/data-table"
import { taskStatusFilterValues } from "@/pages/tasks/columns"

export function useTasksTableState() {
  const baseState = useDataTableState({
    defaultSort: {
      desc: true,
      id: "firstSeenInWindow",
    },
  })
  const [filters, setFilters] = useQueryStates(
    {
      status: parseAsStringLiteral(taskStatusFilterValues).withDefault("all"),
    },
    {
      history: "replace",
    }
  )

  const setStatus = (value: string) => {
    const nextStatus = taskStatusFilterValues.includes(
      value as (typeof taskStatusFilterValues)[number]
    )
      ? (value as (typeof taskStatusFilterValues)[number])
      : "all"

    baseState.setPageIndex(0)
    void setFilters({
      status: nextStatus === "all" ? null : nextStatus,
    })
  }

  const resetFilters = () => {
    baseState.resetBaseState()
    void setFilters({
      status: null,
    })
  }

  return {
    ...baseState,
    hasActiveFilters: baseState.hasBaseState || filters.status !== "all",
    resetFilters,
    setStatus,
    status: filters.status,
  }
}
