import type { ColumnFiltersState } from "@tanstack/react-table"
import { parseAsString, useQueryStates } from "nuqs"

import { useDataTableState } from "@/components/data-table"

export function useHistoryTableState() {
  const baseState = useDataTableState({
    defaultSort: {
      desc: true,
      id: "createdAt",
    },
  })
  const [filters, setFilters] = useQueryStates(
    {
      repo: parseAsString.withDefault("all"),
      stage: parseAsString.withDefault("all"),
    },
    {
      history: "replace",
    }
  )

  const columnFilters: ColumnFiltersState = [
    ...(filters.stage === "all"
      ? []
      : [
          {
            id: "stage",
            value: filters.stage,
          },
        ]),
    ...(filters.repo === "all"
      ? []
      : [
          {
            id: "target",
            value: filters.repo,
          },
        ]),
  ]

  const setRepo = (value: string) => {
    baseState.setPageIndex(0)
    void setFilters({
      repo: value === "all" ? null : value,
    })
  }

  const setStage = (value: string) => {
    baseState.setPageIndex(0)
    void setFilters({
      stage: value === "all" ? null : value,
    })
  }

  const resetFilters = () => {
    baseState.resetBaseState()
    void setFilters({
      repo: null,
      stage: null,
    })
  }

  return {
    ...baseState,
    columnFilters,
    hasActiveFilters:
      baseState.hasBaseState ||
      filters.repo !== "all" ||
      filters.stage !== "all",
    repo: filters.repo,
    resetFilters,
    setRepo,
    setStage,
    stage: filters.stage,
  }
}
