import type { ColumnFiltersState } from "@tanstack/react-table"
import { parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs"

import { useDataTableState } from "@/components/data-table"
import { attemptStatusFilterValues } from "@/pages/attempts/columns"

export function useAttemptsTableState() {
  const baseState = useDataTableState({
    defaultSort: {
      desc: true,
      id: "startedAt",
    },
  })
  const [filters, setFilters] = useQueryStates(
    {
      status: parseAsStringLiteral(attemptStatusFilterValues).withDefault("all"),
      taskId: parseAsString.withDefault(""),
    },
    {
      history: "replace",
    }
  )

  const columnFilters: ColumnFiltersState =
    filters.status === "all"
      ? []
      : [
          {
            id: "status",
            value: filters.status,
          },
        ]

  const setStatus = (value: string) => {
    const nextStatus = attemptStatusFilterValues.includes(
      value as (typeof attemptStatusFilterValues)[number]
    )
      ? (value as (typeof attemptStatusFilterValues)[number])
      : "all"

    baseState.setPageIndex(0)
    void setFilters({
      status: nextStatus === "all" ? null : nextStatus,
    })
  }

  const clearTaskId = () => {
    baseState.setPageIndex(0)
    void setFilters({ taskId: null })
  }

  const resetFilters = () => {
    baseState.resetBaseState()
    void setFilters({
      status: null,
      taskId: null,
    })
  }

  const taskId = filters.taskId === "" ? null : filters.taskId

  return {
    ...baseState,
    clearTaskId,
    columnFilters,
    hasActiveFilters:
      baseState.hasBaseState || filters.status !== "all" || taskId !== null,
    resetFilters,
    setStatus,
    status: filters.status,
    taskId,
  }
}
