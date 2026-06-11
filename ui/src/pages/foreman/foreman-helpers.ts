import type { DataTableFilterOption } from "@/components/data-table"
import type { ForemanTask } from "@/lib/api"

// Scope = which set the manager fetches. `candidates` is the mirrored,
// scheduler-visible set; `assigned` broadens to every issue assigned to the
// user (a live backend query) so untagged issues can be marked for Foreman.
// Unlike the facets below this drives the query, not a client-side filter.
export const foremanScopeValues = ["candidates", "assigned"] as const
export type ForemanScope = (typeof foremanScopeValues)[number]

// Foreman on/off facet — `on` = agent may pick the issue up (agentEnabled).
export const foremanOnOffValues = ["all", "on", "off"] as const
export type ForemanOnOff = (typeof foremanOnOffValues)[number]

// Frontmatter facet — `needs-fixing` collapses broken ∪ missing (the tagged
// issues that look ready but can't actually produce targets).
export const foremanFrontmatterValues = ["all", "valid", "needs-fixing"] as const
export type ForemanFrontmatterFilter = (typeof foremanFrontmatterValues)[number]

export const foremanOnOffOptions: DataTableFilterOption[] = [
  { label: "On", value: "on" },
  { label: "Off", value: "off" },
]

export const foremanFrontmatterOptions: DataTableFilterOption[] = [
  { label: "Valid", value: "valid" },
  { label: "Needs fixing", value: "needs-fixing" },
]

// Sentinel for the "no assignee" facet option. Select item values cannot be
// empty strings (learning 01KT8Z53FBSFF1Y2TP49P4G1TF), and it must stay
// distinct from the "all" sentinel the shared filter-select reserves.
export const UNASSIGNED_VALUE = "unassigned"

// An "agent label" is any label the workspace configured as an include label.
// This is intentionally broader than the backend's configuredAgentLabel
// (strictly includeLabels[0], used for issue selection/creation): for scope and
// facets we treat every configured include label as an agent tag, so a
// multi-agent setup (agent:tars, agent:michael, …) all reads as tagged. Until
// the settings query resolves we fall back to the `agent:` naming convention so
// the union scope and facets populate rather than flashing empty.
export function agentLabelsOf(task: ForemanTask, includeLabels: string[]): string[] {
  if (includeLabels.length > 0) {
    return task.labels.filter((label) => includeLabels.includes(label))
  }
  return task.labels.filter((label) => /^agent[:_-]/i.test(label))
}

export function isAgentTagged(task: ForemanTask, includeLabels: string[]): boolean {
  return agentLabelsOf(task, includeLabels).length > 0
}

// The `candidates` scope's client-side narrowing: the union of ready-state and
// agent-tagged issues. The `assigned` scope bypasses this (the page shows the
// backend's full assigned set there), so this only filters the mirrored
// candidate set — where the ready clause is forward-compatible headroom.
export function isInForemanScope(task: ForemanTask, includeLabels: string[]): boolean {
  return task.state === "ready" || isAgentTagged(task, includeLabels)
}

export function matchesFrontmatterFilter(
  task: ForemanTask,
  filter: ForemanFrontmatterFilter
): boolean {
  switch (filter) {
    case "all":
      return true
    case "valid":
      return task.frontmatter.state === "valid"
    case "needs-fixing":
      return (
        task.frontmatter.state === "broken" || task.frontmatter.state === "missing"
      )
  }
}

export function matchesOnOffFilter(task: ForemanTask, filter: ForemanOnOff): boolean {
  switch (filter) {
    case "all":
      return true
    case "on":
      return task.agentEnabled
    case "off":
      return !task.agentEnabled
  }
}
