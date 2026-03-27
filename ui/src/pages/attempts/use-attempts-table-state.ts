import type { ColumnFiltersState } from "@tanstack/react-table"
import { parseAsStringLiteral, useQueryStates } from "nuqs"

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

  const resetFilters = () => {
    baseState.resetBaseState()
    void setFilters({
      status: null,
    })
  }

  return {
    ...baseState,
    columnFilters,
    hasActiveFilters: baseState.hasBaseState || filters.status !== "all",
    resetFilters,
    setStatus,
    status: filters.status,
  }
}
