import { parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs"

import { useDataTableState } from "@/components/data-table"
import {
  foremanFrontmatterValues,
  foremanOnOffValues,
} from "@/pages/foreman/foreman-helpers"

export function useForemanTableState() {
  const baseState = useDataTableState({
    defaultSort: {
      desc: true,
      id: "id",
    },
  })
  // Agent label and assignee are open value sets (driven by the data), so they
  // use free-string params; on/off and frontmatter are fixed literal sets.
  const [filters, setFilters] = useQueryStates(
    {
      agent: parseAsString.withDefault("all"),
      assignee: parseAsString.withDefault("all"),
      onoff: parseAsStringLiteral(foremanOnOffValues).withDefault("all"),
      frontmatter:
        parseAsStringLiteral(foremanFrontmatterValues).withDefault("all"),
    },
    {
      history: "replace",
    }
  )

  const setAgent = (value: string) => {
    baseState.setPageIndex(0)
    void setFilters({ agent: value === "all" ? null : value })
  }

  const setAssignee = (value: string) => {
    baseState.setPageIndex(0)
    void setFilters({ assignee: value === "all" ? null : value })
  }

  const setOnOff = (value: string) => {
    const next = foremanOnOffValues.includes(
      value as (typeof foremanOnOffValues)[number]
    )
      ? (value as (typeof foremanOnOffValues)[number])
      : "all"

    baseState.setPageIndex(0)
    void setFilters({ onoff: next === "all" ? null : next })
  }

  const setFrontmatter = (value: string) => {
    const next = foremanFrontmatterValues.includes(
      value as (typeof foremanFrontmatterValues)[number]
    )
      ? (value as (typeof foremanFrontmatterValues)[number])
      : "all"

    baseState.setPageIndex(0)
    void setFilters({ frontmatter: next === "all" ? null : next })
  }

  const resetFilters = () => {
    baseState.resetBaseState()
    void setFilters({
      agent: null,
      assignee: null,
      onoff: null,
      frontmatter: null,
    })
  }

  return {
    ...baseState,
    agent: filters.agent,
    assignee: filters.assignee,
    onoff: filters.onoff,
    frontmatter: filters.frontmatter,
    hasActiveFilters:
      baseState.hasBaseState ||
      filters.agent !== "all" ||
      filters.assignee !== "all" ||
      filters.onoff !== "all" ||
      filters.frontmatter !== "all",
    resetFilters,
    setAgent,
    setAssignee,
    setOnOff,
    setFrontmatter,
  }
}
