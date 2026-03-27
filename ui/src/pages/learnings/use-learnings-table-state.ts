import type { ColumnFiltersState } from "@tanstack/react-table"
import { parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs"

import { useDataTableState } from "@/components/data-table"
import { learningConfidenceFilterValues } from "@/pages/learnings/columns"

export function useLearningsTableState() {
  const baseState = useDataTableState({
    defaultSort: {
      desc: true,
      id: "updatedAt",
    },
  })
  const [filters, setFilters] = useQueryStates(
    {
      confidence: parseAsStringLiteral(learningConfidenceFilterValues).withDefault(
        "all"
      ),
      repo: parseAsString.withDefault("all"),
    },
    {
      history: "replace",
    }
  )

  const columnFilters: ColumnFiltersState = [
    ...(filters.confidence === "all"
      ? []
      : [
          {
            id: "confidence",
            value: filters.confidence,
          },
        ]),
    ...(filters.repo === "all"
      ? []
      : [
          {
            id: "repo",
            value: filters.repo,
          },
        ]),
  ]

  const setConfidence = (value: string) => {
    const nextConfidence = learningConfidenceFilterValues.includes(
      value as (typeof learningConfidenceFilterValues)[number]
    )
      ? (value as (typeof learningConfidenceFilterValues)[number])
      : "all"

    baseState.setPageIndex(0)
    void setFilters({
      confidence: nextConfidence === "all" ? null : nextConfidence,
    })
  }

  const setRepo = (value: string) => {
    baseState.setPageIndex(0)
    void setFilters({
      repo: value === "all" ? null : value,
    })
  }

  const resetFilters = () => {
    baseState.resetBaseState()
    void setFilters({
      confidence: null,
      repo: null,
    })
  }

  return {
    ...baseState,
    columnFilters,
    confidence: filters.confidence,
    hasActiveFilters:
      baseState.hasBaseState ||
      filters.confidence !== "all" ||
      filters.repo !== "all",
    repo: filters.repo,
    resetFilters,
    setConfidence,
    setRepo,
  }
}
