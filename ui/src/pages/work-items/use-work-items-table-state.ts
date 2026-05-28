import { parseAsStringLiteral, useQueryStates } from "nuqs"

import { useDataTableState } from "@/components/data-table"
import { workItemStatusFilterValues } from "@/pages/work-items/columns"

export function useWorkItemsTableState() {
  const baseState = useDataTableState({
    defaultSort: {
      desc: true,
      id: "firstSeenInWindow",
    },
  })
  const [filters, setFilters] = useQueryStates(
    {
      status: parseAsStringLiteral(workItemStatusFilterValues).withDefault("all"),
    },
    {
      history: "replace",
    }
  )

  const setStatus = (value: string) => {
    const nextStatus = workItemStatusFilterValues.includes(
      value as (typeof workItemStatusFilterValues)[number]
    )
      ? (value as (typeof workItemStatusFilterValues)[number])
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
