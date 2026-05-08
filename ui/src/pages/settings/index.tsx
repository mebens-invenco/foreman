import { useEffect, useState, type ReactNode } from "react"

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
  return "text-xxs font-medium tracking-[0.22em] text-muted-foreground uppercase"
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
}: {
  label: string
  value: string
  onCommit: (value: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value)

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
    <label className="space-y-1">
      <span className={labelClassName()}>{label}</span>
      <Input
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

function NumberField({
  label,
  value,
  onCommit,
  disabled,
  min = 1,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
  disabled?: boolean
  min?: number
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
    <label className="space-y-1">
      <span className={labelClassName()}>{label}</span>
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
    </label>
  )
}

function ListField({
  label,
  values,
  onCommit,
  disabled,
  requireValue = false,
}: {
  label: string
  values: string[]
  onCommit: (values: string[]) => void
  disabled?: boolean
  requireValue?: boolean
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
    <label className="space-y-1">
      <span className={labelClassName()}>{label}</span>
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
    </label>
  )
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className={labelClassName()}>{label}</p>
      <p className="min-h-8 border border-border/70 bg-background/70 px-2.5 py-2 text-xs break-all text-foreground">
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
}: {
  label: string
  enabled: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <div className="space-y-1">
      <p className={labelClassName()}>{label}</p>
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
}: {
  label: string
  value: string
  values: string[]
  disabled?: boolean
  onCommit: (value: string) => void
}) {
  return (
    <div className="space-y-1">
      <p className={labelClassName()}>{label}</p>
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

function ReadonlyList({ label, values }: { label: string; values: string[] }) {
  return <ReadonlyField label={label} value={values.length > 0 ? values.join(", ") : "none"} />
}

function runnerPatch(role: RunnerRole, patch: Partial<RunnerProvider>): SettingsPatch {
  return { runner: { [role]: patch } } as SettingsPatch
}

function runnerForType(type: RunnerProvider["type"], current: RunnerProvider): RunnerProvider {
  if (type === "opencode") {
    return {
      type,
      model: current.model || "openai/gpt-5.4",
      variant: "high",
      timeoutMs: current.timeoutMs,
    }
  }
  return {
    type,
    model: current.model || "claude-opus-4-6",
    effort: "high",
    timeoutMs: current.timeoutMs,
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
          value={runner.type}
          values={["opencode", "claude"]}
          disabled={disabled}
          onCommit={(type) =>
            patch(runnerPatch(role, runnerForType(type as RunnerProvider["type"], runner)))
          }
        />
        <TextField
          label="Model"
          value={runner.model}
          disabled={disabled}
          onCommit={(model) => patch(runnerPatch(role, { model }))}
        />
        {runner.type === "opencode" ? (
          <TextField
            label="Variant"
            value={runner.variant}
            disabled={disabled}
            onCommit={(variant) => patch(runnerPatch(role, { variant }))}
          />
        ) : (
          <TextField
            label="Effort"
            value={runner.effort}
            disabled={disabled}
            onCommit={(effort) => patch(runnerPatch(role, { effort }))}
          />
        )}
        <NumberField
          label="Timeout ms"
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

  return (
    <div className="space-y-3">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-3xl tracking-tight text-foreground">Settings</h2>
          <p className="text-sm text-muted-foreground">Click or blur to sync to workspace config.</p>
        </div>
        <p className="text-xxs tracking-[0.22em] text-muted-foreground uppercase">
          {disabled ? "Saving" : "Live"}
        </p>
      </header>

      <SectionCard title="Workspace" meta={`v${config.version}`}>
        <FieldGrid>
          <TextField
            label="Name"
            value={config.workspace.name}
            disabled={disabled}
            onCommit={(name) => patch({ workspace: { name } })}
          />
          <TextField
            label="Agent prefix"
            value={config.workspace.agentPrefix}
            disabled={disabled}
            onCommit={(agentPrefix) => patch({ workspace: { agentPrefix } })}
          />
          <ReadonlyField label="HTTP host" value={config.http.host} />
          <ReadonlyField label="HTTP port" value={String(config.http.port)} />
        </FieldGrid>
        <div className="mt-2 grid gap-2 lg:grid-cols-4">
          <ReadonlyList label="Explicit repos" values={config.repos.explicit} />
          <ReadonlyList label="Repo roots" values={config.repos.roots} />
          <ReadonlyList label="Ignore" values={config.repos.ignore} />
          <ReadonlyList label="Done on merge" values={config.repos.reposDoneOnMerge} />
        </div>
      </SectionCard>

      <SectionCard title="Task System" meta={taskType}>
        {taskType === "file" && fileConfig ? (
          <>
            <FieldGrid>
              <TextField
                label="Tasks dir"
                value={fileConfig.tasksDir}
                disabled={disabled}
                onCommit={(tasksDir) => patch({ taskSystem: { file: { tasksDir } } })}
              />
              <TextField
                label="ID prefix"
                value={fileConfig.idPrefix}
                disabled={disabled}
                onCommit={(idPrefix) => patch({ taskSystem: { file: { idPrefix } } })}
              />
            </FieldGrid>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {stateFields.map(([key, label]) => (
                <ListField
                  key={key}
                  label={label}
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
                value={linearConfig.team}
                disabled={disabled}
                onCommit={(team) => patch({ taskSystem: { linear: { team } } })}
              />
              <TextField
                label="Assignee"
                value={linearConfig.assignee}
                disabled={disabled}
                onCommit={(assignee) => patch({ taskSystem: { linear: { assignee } } })}
              />
              <ListField
                label="Include labels"
                values={linearConfig.includeLabels}
                disabled={disabled}
                onCommit={(includeLabels) => patch({ taskSystem: { linear: { includeLabels } } })}
              />
              <TextField
                label="Agent-created label"
                value={linearConfig.agentCreatedLabel}
                disabled={disabled}
                onCommit={(agentCreatedLabel) => patch({ taskSystem: { linear: { agentCreatedLabel } } })}
              />
              <TextField
                label="Consolidated label"
                value={linearConfig.consolidatedLabel}
                disabled={disabled}
                onCommit={(consolidatedLabel) => patch({ taskSystem: { linear: { consolidatedLabel } } })}
              />
            </FieldGrid>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {stateFields.map(([key, label]) => (
                <ListField
                  key={key}
                  label={label}
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

      <SectionCard title="Runners">
        <div className="grid gap-2 lg:grid-cols-2">
          <RunnerFields role="execution" runner={config.runner.execution} disabled={disabled} patch={patch} />
          <RunnerFields role="reviewer" runner={config.runner.reviewer} disabled={disabled} patch={patch} />
        </div>
      </SectionCard>

      <SectionCard title="Scheduling">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <NumberField
            label="Workers"
            value={config.scheduler.workerConcurrency}
            disabled={disabled}
            onCommit={(workerConcurrency) => patch({ scheduler: { workerConcurrency } })}
          />
          <NumberField
            label="Scout poll sec"
            value={config.scheduler.scoutPollIntervalSeconds}
            disabled={disabled}
            onCommit={(scoutPollIntervalSeconds) => patch({ scheduler: { scoutPollIntervalSeconds } })}
          />
          <NumberField
            label="Scout debounce ms"
            value={config.scheduler.scoutRerunDebounceMs}
            min={0}
            disabled={disabled}
            onCommit={(scoutRerunDebounceMs) => patch({ scheduler: { scoutRerunDebounceMs } })}
          />
          <NumberField
            label="Lease TTL sec"
            value={config.scheduler.leaseTtlSeconds}
            disabled={disabled}
            onCommit={(leaseTtlSeconds) => patch({ scheduler: { leaseTtlSeconds } })}
          />
          <NumberField
            label="Heartbeat sec"
            value={config.scheduler.workerHeartbeatSeconds}
            disabled={disabled}
            onCommit={(workerHeartbeatSeconds) => patch({ scheduler: { workerHeartbeatSeconds } })}
          />
          <NumberField
            label="Reap sec"
            value={config.scheduler.staleLeaseReapIntervalSeconds}
            disabled={disabled}
            onCommit={(staleLeaseReapIntervalSeconds) => patch({ scheduler: { staleLeaseReapIntervalSeconds } })}
          />
          <NumberField
            label="Loop ms"
            value={config.scheduler.schedulerLoopIntervalMs}
            disabled={disabled}
            onCommit={(schedulerLoopIntervalMs) => patch({ scheduler: { schedulerLoopIntervalMs } })}
          />
          <NumberField
            label="Shutdown grace sec"
            value={config.scheduler.shutdownGracePeriodSeconds}
            disabled={disabled}
            onCommit={(shutdownGracePeriodSeconds) => patch({ scheduler: { shutdownGracePeriodSeconds } })}
          />
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <ToggleField
            label="Cron"
            enabled={config.cron.enabled}
            disabled={disabled}
            onToggle={() => patch({ cron: { enabled: !config.cron.enabled } })}
          />
          <TextField
            label="Cron jobs dir"
            value={config.cron.jobsDir}
            disabled={disabled}
            onCommit={(jobsDir) => patch({ cron: { jobsDir } })}
          />
          <ToggleField
            label="Agent task creation"
            enabled={config.agentTaskCreation.enabled}
            disabled={disabled}
            onToggle={() =>
              patch({ agentTaskCreation: { enabled: !config.agentTaskCreation.enabled } })
            }
          />
        </div>
      </SectionCard>

      <SectionCard title="Review & Deployment" meta={config.reviewSystem.type}>
        <FieldGrid>
          <TextField
            label="Review prefix"
            value={config.reviewer.agentPrefix}
            disabled={disabled}
            onCommit={(agentPrefix) => patch({ reviewer: { agentPrefix } })}
          />
          <NumberField
            label="Min retry min"
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
          <ReadonlyField label="Review system" value={config.reviewSystem.type} />
        </FieldGrid>
      </SectionCard>
    </div>
  )
}
