import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TaskLink } from "@/components/task-link"
import { useSetAgentEnabledMutation } from "@/hooks/use-foreman-tasks-query"
import { cn } from "@/lib/utils"
import { ForemanSwitch } from "@/pages/foreman/foreman-switch"
import { isAgentTagged } from "@/pages/foreman/foreman-helpers"
import type { ForemanTask } from "@/lib/api"

// Reuse the established tone tokens (amber = suspicious, rose = error) so the
// frontmatter badges read the same as status badges elsewhere — no new colors.
const FRONTMATTER_WARN_TONE =
  "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
const FRONTMATTER_ERROR_TONE =
  "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"

type ForemanCellProps = {
  task: ForemanTask
  includeLabels: string[]
}

export function FrontmatterCell({ task, includeLabels }: ForemanCellProps) {
  // Untagged rows aren't fetched as candidates, so their frontmatter is n/a
  // until they're marked for Foreman — show a muted dash, not a false "missing".
  if (!isAgentTagged(task, includeLabels)) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  const { state, repos, detail } = task.frontmatter

  if (state === "valid") {
    if (repos.length === 0) {
      return <span className="text-xs text-muted-foreground">—</span>
    }
    return (
      <div className="flex flex-wrap gap-1">
        {repos.map((repo) => (
          <span
            key={repo}
            className="inline-flex items-center rounded-none border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-xxs text-foreground"
          >
            {repo}
          </span>
        ))}
      </div>
    )
  }

  const tone = state === "broken" ? FRONTMATTER_WARN_TONE : FRONTMATTER_ERROR_TONE
  const label = state === "broken" ? "⚠ no Repos:" : "✗ no metadata"

  // Read-only in v1: the badge links out to Linear, where the description (and
  // its Agent: block) gets fixed. Tooltip carries the parser's detail.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <TaskLink
            taskUrl={task.url}
            className={cn(
              "inline-flex items-center gap-1 rounded-none border px-1.5 py-0.5 text-xxs font-medium",
              tone
            )}
          >
            {label}
          </TaskLink>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{detail ?? label}</TooltipContent>
    </Tooltip>
  )
}

export function ForemanToggleCell({ task, includeLabels }: ForemanCellProps) {
  const mutation = useSetAgentEnabledMutation()

  // One control answering "should Foreman work this issue?". Tagged rows get an
  // on/off switch; an untagged row (surfaced by the "All my tickets" scope)
  // instead offers to mark it — the enable mutation adds the configured agent
  // label server-side, so the issue becomes a Foreman candidate.
  if (!isAgentTagged(task, includeLabels)) {
    return (
      <Button
        disabled={mutation.isPending}
        onClick={() => mutation.mutate({ taskId: task.id, enabled: true })}
        size="xs"
        variant="outline"
      >
        <PlusIcon />
        mark for Foreman
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <ForemanSwitch
        checked={task.agentEnabled}
        disabled={mutation.isPending}
        label={`Foreman ${task.agentEnabled ? "on" : "off"} for ${task.id}`}
        onCheckedChange={(enabled) =>
          mutation.mutate({ taskId: task.id, enabled })
        }
      />
      <span
        className={cn(
          // Fixed width so "On"→"Off" doesn't change the cell's content width
          // and reflow the (content-sized) table column on every toggle.
          "inline-block w-7 text-xxs font-medium tracking-[0.18em] uppercase",
          task.agentEnabled
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-muted-foreground"
        )}
      >
        {task.agentEnabled ? "On" : "Off"}
      </span>
    </div>
  )
}
