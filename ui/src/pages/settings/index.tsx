import { useEffect, useState, type ReactNode } from "react"

import { SaveIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useSettingsQuery, usePatchSettingsMutation } from "@/hooks/use-settings-query"
import { useStatusQuery } from "@/hooks/use-status-query"
import { cn } from "@/lib/utils"

function StatePill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-none border px-2 py-1 text-xxs font-medium tracking-[0.18em] uppercase",
        enabled
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"
      )}
    >
      {enabled ? "Enabled" : "Disabled"}
    </span>
  )
}

function ToggleSettingCard({
  title,
  description,
  enabled,
  disabled,
  onToggle,
  children,
}: {
  title: string
  description: string
  enabled: boolean
  disabled?: boolean
  onToggle: () => void
  children?: ReactNode
}) {
  return (
    <section className="border border-border/70 bg-card/80 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-lg tracking-tight text-foreground">{title}</h3>
            <StatePill enabled={enabled} />
          </div>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
            {description}
          </p>
        </div>

        <Button
          type="button"
          variant={enabled ? "secondary" : "default"}
          onClick={onToggle}
          disabled={disabled}
          className="shrink-0"
        >
          {enabled ? "Disable" : "Enable"}
        </Button>
      </div>

      {children ? <div className="mt-5">{children}</div> : null}
    </section>
  )
}

function SettingDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border/70 bg-background/70 px-4 py-3">
      <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-2 text-sm leading-6 break-all text-foreground">{value}</p>
    </div>
  )
}

export function SettingsPage() {
  const { data: settings, isLoading, isError, error } = useSettingsQuery()
  const { data: status } = useStatusQuery()
  const patchSettings = usePatchSettingsMutation()
  const [jobsDir, setJobsDir] = useState("")

  useEffect(() => {
    if (settings?.cron.jobsDir) {
      setJobsDir(settings.cron.jobsDir)
    }
  }, [settings?.cron.jobsDir])

  if (isLoading && !settings) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-36 w-full" />
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

  if (!settings) {
    return null
  }

  const cronEnabled = settings.cron.enabled
  const agentTaskCreationEnabled = settings.agentTaskCreation.enabled
  const normalizedJobsDir = jobsDir.trim()
  const jobsDirChanged = normalizedJobsDir !== "" && normalizedJobsDir !== settings.cron.jobsDir
  const mutationPending = patchSettings.isPending

  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-3xl tracking-tight text-foreground">Settings</h2>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
          Control Foreman cron scheduling and whether cron prompts may create
          agent tasks. Changes are applied to the live scheduler configuration
          and persisted to the workspace config.
        </p>
      </header>

      <ToggleSettingCard
        title="Cron scheduling"
        description="Allow the scheduler to discover cron job markdown files and enqueue recurring cron jobs."
        enabled={cronEnabled}
        disabled={mutationPending}
        onToggle={() =>
          patchSettings.mutate({ cron: { enabled: !cronEnabled } })
        }
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <label className="space-y-2">
            <span className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
              Cron jobs directory
            </span>
            <Input
              value={jobsDir}
              onChange={(event) => setJobsDir(event.target.value)}
              placeholder="cron"
              disabled={mutationPending}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            className="self-end"
            disabled={!jobsDirChanged || mutationPending}
            onClick={() => patchSettings.mutate({ cron: { jobsDir: normalizedJobsDir } })}
          >
            <SaveIcon className="size-3.5" />
            Save directory
          </Button>
        </div>
      </ToggleSettingCard>

      <ToggleSettingCard
        title="Agent task creation"
        description="Allow cron prompts to request Foreman task mutations when they identify follow-up work."
        enabled={agentTaskCreationEnabled}
        disabled={mutationPending}
        onToggle={() =>
          patchSettings.mutate({
            agentTaskCreation: { enabled: !agentTaskCreationEnabled },
          })
        }
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SettingDetail
          label="Persisted cron"
          value={settings.cron.enabled ? "enabled" : "disabled"}
        />
        <SettingDetail
          label="Runtime cron"
          value={status ? (status.cron.enabled ? "enabled" : "disabled") : "loading"}
        />
        <SettingDetail label="Jobs directory" value={settings.cron.jobsDir} />
        <SettingDetail
          label="Persisted agent tasks"
          value={settings.agentTaskCreation.enabled ? "enabled" : "disabled"}
        />
        <SettingDetail
          label="Runtime agent tasks"
          value={
            status
              ? status.agentTaskCreation.enabled
                ? "enabled"
                : "disabled"
              : "loading"
          }
        />
      </section>
    </div>
  )
}
