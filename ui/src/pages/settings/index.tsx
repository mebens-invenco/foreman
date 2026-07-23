import { useEffect, useId, useState, type ReactNode } from "react"

import { CircleHelpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { usePatchSettingsMutation, useSettingsQuery } from "@/hooks/use-settings-query"
import type {
  RunnerProvider,
  SettingsPatch,
  TaskProviderStates,
  WorkspaceConfig,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const stateFields = [
  ["ready", "Ready"],
  ["inProgress", "In progress"],
  ["inReview", "In review"],
  ["deployable", "Deployable"],
  ["done", "Done"],
  ["canceled", "Canceled"],
] as const satisfies ReadonlyArray<[keyof TaskProviderStates, string]>

type RunnerRole = keyof WorkspaceConfig["runner"]

function labelClassName() {
  return "flex h-4 items-center gap-1 whitespace-nowrap text-xxs leading-4 font-medium tracking-[0.22em] text-muted-foreground uppercase"
}

function fieldClassName() {
  return "grid gap-1"
}

function SettingLabel({ label, help }: { label: string; help: string }) {
  return (
    <div className={labelClassName()}>
      <span>{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`${label} help`}
            className="size-3.5 border-0 bg-transparent p-0 text-muted-foreground/70 hover:bg-transparent hover:text-foreground"
          >
            <CircleHelpIcon className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 normal-case tracking-normal">
          {help}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function SectionCard({
  title,
  meta,
  children,
}: {
  title: string
  meta?: string
  children: ReactNode
}) {
  return (
    <section className="border border-border/70 bg-card/80 p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-base tracking-tight text-foreground">{title}</h3>
        {meta ? (
          <span className="border border-border/70 px-2 py-1 text-xxs tracking-[0.22em] text-muted-foreground uppercase">
            {meta}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{children}</div>
}

function TextField({
  label,
  value,
  onCommit,
  disabled,
  placeholder,
  help,
  suggestions,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
  disabled?: boolean
  placeholder?: string
  help: string
  suggestions?: readonly string[]
}) {
  const [draft, setDraft] = useState(value)
  const reactId = useId()
  const listId = suggestions && suggestions.length > 0 ? `${reactId}-list` : undefined

  useEffect(() => {
    setDraft(value)
  }, [value])

  function commit() {
    if (draft.trim().length === 0) {
      setDraft(value)
      return
    }
    if (draft !== value) {
      onCommit(draft)
    }
  }

  return (
    <div className={fieldClassName()}>
      <SettingLabel label={label} help={help} />
      <Input
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        list={listId}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur()
          }
        }}
      />
      {listId ? (
        <datalist id={listId}>
          {suggestions!.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
    </div>
  )
}

function NumberField({
  label,
  value,
  onCommit,
  disabled,
  min = 1,
  help,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
  disabled?: boolean
  min?: number
  help: string
}) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  function commit() {
    const next = Number.parseInt(draft, 10)
    if (!Number.isInteger(next) || next < min) {
      setDraft(String(value))
      return
    }
    if (next !== value) {
      onCommit(next)
    }
  }

  return (
    <div className={fieldClassName()}>
      <SettingLabel label={label} help={help} />
      <Input
        type="number"
        min={min}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

function ListField({
  label,
  values,
  onCommit,
  disabled,
  requireValue = false,
  help,
}: {
  label: string
  values: string[]
  onCommit: (values: string[]) => void
  disabled?: boolean
  requireValue?: boolean
  help: string
}) {
  const value = values.join(", ")
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  function commit() {
    const next = draft
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    if (requireValue && next.length === 0) {
      setDraft(value)
      return
    }
    if (next.join("\u0000") !== values.join("\u0000")) {
      onCommit(next)
    }
  }

  return (
    <div className={fieldClassName()}>
      <SettingLabel label={label} help={help} />
      <Input
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

function ReadonlyField({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className={fieldClassName()}>
      <SettingLabel label={label} help={help} />
      <p
        title={value || "-"}
        className="flex h-8 items-center truncate border border-border/70 bg-background/70 px-2.5 text-xs text-foreground"
      >
        {value || "-"}
      </p>
    </div>
  )
}

function ToggleField({
  label,
  enabled,
  disabled,
  onToggle,
  help,
}: {
  label: string
  enabled: boolean
  disabled?: boolean
  onToggle: () => void
  help: string
}) {
  return (
    <div className={fieldClassName()}>
      <SettingLabel label={label} help={help} />
      <Button
        type="button"
        variant={enabled ? "secondary" : "outline"}
        disabled={disabled}
        onClick={onToggle}
        className={cn("w-full justify-between", enabled && "text-emerald-700 dark:text-emerald-300")}
      >
        <span>{enabled ? "Enabled" : "Disabled"}</span>
        <span className="text-xxs tracking-[0.22em] uppercase">Click</span>
      </Button>
    </div>
  )
}

function SelectField({
  label,
  value,
  values,
  disabled,
  onCommit,
  help,
}: {
  label: string
  value: string
  values: string[]
  disabled?: boolean
  onCommit: (value: string) => void
  help: string
}) {
  return (
    <div className={fieldClassName()}>
      <SettingLabel label={label} help={help} />
      <Select value={value} disabled={disabled} onValueChange={onCommit}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ReadonlyList({ label, values, help }: { label: string; values: string[]; help: string }) {
  return <ReadonlyField label={label} value={values.length > 0 ? values.join(", ") : "none"} help={help} />
}

function runnerPatch(role: RunnerRole, patch: Partial<RunnerProvider>): SettingsPatch {
  return { runner: { [role]: patch } } as SettingsPatch
}

function runnerForType(type: RunnerProvider["type"], current: RunnerProvider): RunnerProvider {
  switch (type) {
    case "opencode":
      return {
        type,
        model: current.model || "openai/gpt-5.5",
        variant: "high",
        timeoutMs: current.timeoutMs,
      }
    case "claude":
      return {
        type,
        model: current.model || "claude-opus-4-8",
        effort: "high",
        timeoutMs: current.timeoutMs,
      }
    case "codex":
      return {
        type,
        model: current.model || "gpt-5.6-sol",
        effort: "high",
        timeoutMs: current.timeoutMs,
      }
    default: {
      const _exhaustive: never = type
      return _exhaustive
    }
  }
}

const OPENCODE_VARIANT_SUGGESTIONS = ["low", "medium", "high", "xhigh", "max"] as const
const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "max"] as const
const CODEX_EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const

function RunnerTuningField({
  runner,
  role,
  disabled,
  patch,
}: {
  runner: RunnerProvider
  role: RunnerRole
  disabled?: boolean
  patch: (patch: SettingsPatch) => void
}) {
  switch (runner.type) {
    case "opencode":
      return (
        <TextField
          label="Variant"
          help="OpenCode forwards this string to the underlying provider as reasoning effort. Common values: low, medium, high, xhigh, max. Anything is accepted — exact set depends on the model."
          value={runner.variant}
          disabled={disabled}
          suggestions={OPENCODE_VARIANT_SUGGESTIONS}
          onCommit={(variant) => patch(runnerPatch(role, { variant }))}
        />
      )
    case "claude":
      return (
        <SelectField
          label="Effort"
          help="Claude reasoning effort: low, medium, high, or max."
          value={runner.effort}
          values={[...CLAUDE_EFFORT_VALUES]}
          disabled={disabled}
          onCommit={(effort) => patch(runnerPatch(role, { effort }))}
        />
      )
    case "codex":
      return (
        <SelectField
          label="Effort"
          help="Codex reasoning effort (model_reasoning_effort): low, medium, high, or xhigh."
          value={runner.effort}
          values={[...CODEX_EFFORT_VALUES]}
          disabled={disabled}
          onCommit={(effort) => patch(runnerPatch(role, { effort }))}
        />
      )
    default: {
      const _exhaustive: never = runner
      return _exhaustive
    }
  }
}

function RunnerFields({
  role,
  runner,
  disabled,
  patch,
}: {
  role: RunnerRole
  runner: RunnerProvider
  disabled?: boolean
  patch: (patch: SettingsPatch) => void
}) {
  return (
    <div className="border border-border/70 bg-background/40 p-2">
      <p className="mb-2 text-xs font-medium text-foreground capitalize">{role}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <SelectField
          label="Provider"
          help="Runner CLI/provider used for this role. Switching providers also resets the tuning field to that provider's default."
          value={runner.type}
          values={["opencode", "claude", "codex"]}
          disabled={disabled}
          onCommit={(type) =>
            patch(runnerPatch(role, runnerForType(type as RunnerProvider["type"], runner)))
          }
        />
        <TextField
          label="Model"
          help="Model identifier passed to the selected runner provider for this role."
          value={runner.model}
          disabled={disabled}
          onCommit={(model) => patch(runnerPatch(role, { model }))}
        />
        <RunnerTuningField runner={runner} role={role} disabled={disabled} patch={patch} />
        <NumberField
          label="Timeout ms"
          help="Maximum runtime for one runner invocation before Foreman terminates it."
          value={runner.timeoutMs}
          disabled={disabled}
          onCommit={(timeoutMs) => patch(runnerPatch(role, { timeoutMs }))}
        />
      </div>
    </div>
  )
}

function taskStatePatch(
  type: WorkspaceConfig["taskSystem"]["type"],
  state: keyof TaskProviderStates,
  values: string[]
): SettingsPatch {
  return { taskSystem: { [type]: { states: { [state]: values } } } } as SettingsPatch
}

function stateHelp(taskType: WorkspaceConfig["taskSystem"]["type"], label: string) {
  const source = taskType === "linear" ? "Linear workflow states" : "file task states"
  return `${source} mapped to Foreman's ${label.toLowerCase()} task state. Use comma-separated values.`
}

export function SettingsPage() {
  const { data, isLoading, isError, error } = useSettingsQuery()
  const patchSettings = usePatchSettingsMutation()

  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-60" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
        {error instanceof Error ? error.message : "Failed to load settings."}
      </div>
    )
  }

  const config = data?.config
  if (!config) {
    return null
  }

  const disabled = patchSettings.isPending
  const patch = (settingsPatch: SettingsPatch) => patchSettings.mutate(settingsPatch)
  const taskType = config.taskSystem.type
  const fileConfig = config.taskSystem.file
  const linearConfig = config.taskSystem.linear
  const deploymentInstructions = data.deploymentInstructions

  return (
    <div className="space-y-3">
      <header>
        <div>
          <h2 className="text-3xl tracking-tight text-foreground">Settings</h2>
          <p className="text-sm text-muted-foreground">Click or blur to sync to workspace config.</p>
        </div>
      </header>

      <SectionCard title="Workspace">
        <FieldGrid>
          <TextField
            label="Name"
            help="Display name for this Foreman workspace."
            value={config.workspace.name}
            disabled={disabled}
            onCommit={(name) => patch({ workspace: { name } })}
          />
          <TextField
            label="Agent prefix"
            help="Prefix Foreman uses to identify implementation-agent messages. It is also prepended to comments generated by implementation agents."
            value={config.workspace.agentPrefix}
            disabled={disabled}
            onCommit={(agentPrefix) => patch({ workspace: { agentPrefix } })}
          />
          <ReadonlyField label="HTTP host" value={config.http.host} help="Host the Foreman web server binds to. Requires restart to change." />
          <ReadonlyField label="HTTP port" value={String(config.http.port)} help="Port the Foreman web server listens on. Requires restart to change." />
        </FieldGrid>
        <div className="mt-2 grid gap-2 lg:grid-cols-4">
          <ReadonlyList label="Explicit repos" values={config.repos.explicit} help="Specific repository paths Foreman includes during startup discovery." />
          <ReadonlyList label="Repo roots" values={config.repos.roots} help="Directories scanned for git repositories during startup discovery." />
          <ReadonlyList label="Ignore" values={config.repos.ignore} help="Glob patterns excluded from repository discovery." />
          <ReadonlyList label="Done on merge" values={config.repos.reposDoneOnMerge} help="Repository keys whose merged pull requests can mark task targets done." />
        </div>
      </SectionCard>

      <SectionCard title="Runners">
        <div className="grid gap-2 lg:grid-cols-2">
          <RunnerFields role="execution" runner={config.runner.execution} disabled={disabled} patch={patch} />
          <RunnerFields role="reviewer" runner={config.runner.reviewer} disabled={disabled} patch={patch} />
        </div>
      </SectionCard>

      <SectionCard title="Task System" meta={taskType}>
        {taskType === "file" && fileConfig ? (
          <>
            <FieldGrid>
              <TextField
                label="Tasks dir"
                help="Workspace-relative directory containing file task markdown files."
                value={fileConfig.tasksDir}
                disabled={disabled}
                onCommit={(tasksDir) => patch({ taskSystem: { file: { tasksDir } } })}
              />
              <TextField
                label="ID prefix"
                help="Prefix used when Foreman creates new file task IDs."
                value={fileConfig.idPrefix}
                disabled={disabled}
                onCommit={(idPrefix) => patch({ taskSystem: { file: { idPrefix } } })}
              />
            </FieldGrid>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {stateFields.map(([key, label]) => (
                <ListField
                  key={key}
                  label={label}
                  help={stateHelp("file", label)}
                  values={fileConfig.states[key]}
                  disabled={disabled}
                  requireValue
                  onCommit={(values) => patch(taskStatePatch("file", key, values))}
                />
              ))}
            </div>
          </>
        ) : null}

        {taskType === "linear" && linearConfig ? (
          <>
            <FieldGrid>
              <TextField
                label="Team"
                help="Linear team name Foreman reads tasks from and creates tasks in."
                value={linearConfig.team}
                disabled={disabled}
                onCommit={(team) => patch({ taskSystem: { linear: { team } } })}
              />
              <TextField
                label="Assignee"
                help="Linear assignee filter for incoming work. Use me to target the authenticated user."
                value={linearConfig.assignee}
                disabled={disabled}
                onCommit={(assignee) => patch({ taskSystem: { linear: { assignee } } })}
              />
              <ListField
                label="Include labels"
                help="Linear labels a task must include to be considered by Foreman. Use comma-separated values."
                values={linearConfig.includeLabels}
                disabled={disabled}
                onCommit={(includeLabels) => patch({ taskSystem: { linear: { includeLabels } } })}
              />
              <TextField
                label="Agent-created label"
                help="Linear label applied to tasks created by Foreman from agent or cron output."
                value={linearConfig.agentCreatedLabel}
                disabled={disabled}
                onCommit={(agentCreatedLabel) => patch({ taskSystem: { linear: { agentCreatedLabel } } })}
              />
              <TextField
                label="Consolidated label"
                help="Linear label applied when Foreman consolidates task follow-up work."
                value={linearConfig.consolidatedLabel}
                disabled={disabled}
                onCommit={(consolidatedLabel) => patch({ taskSystem: { linear: { consolidatedLabel } } })}
              />
            </FieldGrid>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {stateFields.map(([key, label]) => (
                <ListField
                  key={key}
                  label={label}
                  help={stateHelp("linear", label)}
                  values={linearConfig.states[key]}
                  disabled={disabled}
                  requireValue
                  onCommit={(values) => patch(taskStatePatch("linear", key, values))}
                />
              ))}
            </div>
          </>
        ) : null}
      </SectionCard>

      <SectionCard title="Scheduling">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <NumberField
            label="Workers"
            help="Maximum number of concurrent worker slots Foreman can dispatch jobs to."
            value={config.scheduler.workerConcurrency}
            disabled={disabled}
            onCommit={(workerConcurrency) => patch({ scheduler: { workerConcurrency } })}
          />
          <NumberField
            label="Scout poll sec"
            help="Seconds between scheduled scout runs that look for new work."
            value={config.scheduler.scoutPollIntervalSeconds}
            disabled={disabled}
            onCommit={(scoutPollIntervalSeconds) => patch({ scheduler: { scoutPollIntervalSeconds } })}
          />
          <NumberField
            label="Scout debounce ms"
            help="Delay before non-startup scout reruns, used to coalesce frequent scheduler events."
            value={config.scheduler.scoutRerunDebounceMs}
            min={0}
            disabled={disabled}
            onCommit={(scoutRerunDebounceMs) => patch({ scheduler: { scoutRerunDebounceMs } })}
          />
          <NumberField
            label="Lease TTL sec"
            help="Seconds before a worker lease expires if heartbeats stop."
            value={config.scheduler.leaseTtlSeconds}
            disabled={disabled}
            onCommit={(leaseTtlSeconds) => patch({ scheduler: { leaseTtlSeconds } })}
          />
          <NumberField
            label="Heartbeat sec"
            help="Seconds between worker heartbeat updates while a job is running."
            value={config.scheduler.workerHeartbeatSeconds}
            disabled={disabled}
            onCommit={(workerHeartbeatSeconds) => patch({ scheduler: { workerHeartbeatSeconds } })}
          />
          <NumberField
            label="Reap sec"
            help="Seconds between checks for expired worker leases."
            value={config.scheduler.staleLeaseReapIntervalSeconds}
            disabled={disabled}
            onCommit={(staleLeaseReapIntervalSeconds) => patch({ scheduler: { staleLeaseReapIntervalSeconds } })}
          />
          <NumberField
            label="Loop ms"
            help="Milliseconds between scheduler dispatch loop ticks."
            value={config.scheduler.schedulerLoopIntervalMs}
            disabled={disabled}
            onCommit={(schedulerLoopIntervalMs) => patch({ scheduler: { schedulerLoopIntervalMs } })}
          />
          <NumberField
            label="Shutdown grace sec"
            help="Seconds Foreman waits for active workers to clean up during shutdown."
            value={config.scheduler.shutdownGracePeriodSeconds}
            disabled={disabled}
            onCommit={(shutdownGracePeriodSeconds) => patch({ scheduler: { shutdownGracePeriodSeconds } })}
          />
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <ToggleField
            label="Cron"
            help="Enables recurring cron job discovery and enqueueing from the cron jobs directory."
            enabled={config.cron.enabled}
            disabled={disabled}
            onToggle={() => patch({ cron: { enabled: !config.cron.enabled } })}
          />
          <TextField
            label="Cron jobs dir"
            help="Workspace-relative directory containing cron job markdown files."
            value={config.cron.jobsDir}
            disabled={disabled}
            onCommit={(jobsDir) => patch({ cron: { jobsDir } })}
          />
          <ToggleField
            label="Agent task creation"
            help="Allows cron prompts to create or mutate Foreman tasks when follow-up work is found."
            enabled={config.agentTaskCreation.enabled}
            disabled={disabled}
            onToggle={() =>
              patch({ agentTaskCreation: { enabled: !config.agentTaskCreation.enabled } })
            }
          />
          <ToggleField
            label="Consolidate learnings"
            help="Runs one short agent pass over each Done or Canceled task to extract reusable learnings, then parks it. Does not change code or task state. Costs roughly one agent run per completed task. Turn off to make done mean done with no further scheduling."
            enabled={config.scheduler.consolidateTerminalTasks}
            disabled={disabled}
            onToggle={() =>
              patch({ scheduler: { consolidateTerminalTasks: !config.scheduler.consolidateTerminalTasks } })
            }
          />
        </div>
      </SectionCard>

      <SectionCard title="Review" meta={config.reviewSystem.type}>
        <FieldGrid>
          <TextField
            label="Review prefix"
            help="Prefix Foreman uses to identify reviewer-agent comments. It is also prepended to comments generated by reviewer agents."
            value={config.reviewer.agentPrefix}
            disabled={disabled}
            onCommit={(agentPrefix) => patch({ reviewer: { agentPrefix } })}
          />
          <ReadonlyField label="Review system" value={config.reviewSystem.type} help="Review provider used for pull request context and comments. Requires restart to change." />
        </FieldGrid>
      </SectionCard>

      <SectionCard title="Deployment" meta={deploymentInstructions.active ? "active" : "inactive"}>
        <FieldGrid>
          <ReadonlyField
            label="Status"
            value={deploymentInstructions.active ? "active" : "inactive"}
            help="Deployment tracking is active when deployment.md exists in the workspace root."
          />
          <ReadonlyField
            label="Instructions file"
            value={deploymentInstructions.relativePath}
            help="Workspace-relative deployment instructions file Foreman passes to deployment tracking jobs."
          />
          <NumberField
            label="Min retry min"
            help="Minimum minutes before Foreman retries deployment-related work after a retryable outcome."
            value={config.deployment.minRetryIntervalMinutes}
            disabled={disabled}
            onCommit={(minRetryIntervalMinutes) =>
              patch({
                deployment: {
                  minRetryIntervalMinutes,
                  maxRetryIntervalMinutes: Math.max(
                    config.deployment.maxRetryIntervalMinutes,
                    minRetryIntervalMinutes
                  ),
                },
              })
            }
          />
          <NumberField
            label="Max retry min"
            help="Maximum minutes Foreman waits between deployment retries."
            value={config.deployment.maxRetryIntervalMinutes}
            disabled={disabled}
            onCommit={(maxRetryIntervalMinutes) =>
              patch({
                deployment: {
                  minRetryIntervalMinutes: Math.min(
                    config.deployment.minRetryIntervalMinutes,
                    maxRetryIntervalMinutes
                  ),
                  maxRetryIntervalMinutes,
                },
              })
            }
          />
        </FieldGrid>
      </SectionCard>
    </div>
  )
}
