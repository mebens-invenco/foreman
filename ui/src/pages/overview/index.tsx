import { ActivityIcon, FolderKanbanIcon, OrbitIcon, WorkflowIcon } from "lucide-react"

import { useStatusQuery } from "@/hooks/use-status-query"
import { formatTimestamp } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

function Surface({ className, children }: React.ComponentProps<"section">) {
  return (
    <section className={cn("rounded-none border border-border/70 bg-card/75", className)}>
      {children}
    </section>
  )
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string
  value: string
  detail: string
  icon: typeof OrbitIcon
}) {
  return (
    <Surface className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            {label}
          </p>
          <p className="mt-4 text-2xl tracking-tight text-foreground">{value}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p>
        </div>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-none border border-border bg-background/85">
          <Icon className="size-4" />
        </div>
      </div>
    </Surface>
  )
}

export function OverviewPage() {
  const { data: status, isLoading } = useStatusQuery()
  const integrations: Array<[string, { type: string; status: string }]> = status
    ? [
        ["task system", status.integrations.taskSystem],
        ["review system", status.integrations.reviewSystem],
        ["runner", status.integrations.runner],
      ]
    : []

  if (isLoading && !status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 rounded-none" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32 rounded-none" />
          <Skeleton className="h-32 rounded-none" />
          <Skeleton className="h-32 rounded-none" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)]">
        <Surface className="overflow-hidden p-6">
          <p className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
            Control plane
          </p>
          <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <div>
              <h2 className="max-w-2xl text-3xl leading-tight tracking-tight text-foreground md:text-4xl">
                A dedicated React shell now frames Foreman&apos;s operational surface.
              </h2>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">
                Routing, provider composition, theme controls, Sonner feedback, and
                scheduler actions are now wired into the UI workspace. The data-heavy
                pages can slot into this structure without reworking the shell.
              </p>
            </div>
            <div className="grid gap-3 border border-border/70 bg-background/55 p-4 text-sm text-muted-foreground">
              <div>
                <p className="text-[10px] uppercase tracking-[0.28em]">Workspace</p>
                <p className="mt-2 text-foreground">{status?.workspace.name ?? "-"}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.28em]">Root</p>
                <p className="mt-2 break-all leading-6">{status?.workspace.root ?? "-"}</p>
              </div>
            </div>
          </div>
        </Surface>

        <Surface className="p-6">
          <p className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
            Scout window
          </p>
          <div className="mt-5 space-y-5 text-sm leading-7">
            <div>
              <p className="text-muted-foreground">Last scout run</p>
              <p className="text-lg text-foreground">
                {formatTimestamp(status?.scheduler.lastScoutRunAt ?? null)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Next scout poll</p>
              <p className="text-lg text-foreground">
                {formatTimestamp(status?.scheduler.nextScoutPollAt ?? null)}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Worker concurrency</p>
              <p className="text-lg text-foreground">
                {status?.scheduler.workerConcurrency ?? 0}
              </p>
            </div>
          </div>
        </Surface>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          label="Scheduler"
          value={status?.scheduler.status ?? "unknown"}
          detail={`Polls every ${status?.scheduler.scoutPollIntervalSeconds ?? 0}s.`}
          icon={WorkflowIcon}
        />
        <MetricCard
          label="Integrations"
          value={Object.keys(status?.integrations ?? {}).length.toString()}
          detail="Task system, review handoff, and runner health are all represented in the shell query state."
          icon={ActivityIcon}
        />
        <MetricCard
          label="Repositories"
          value={(status?.repos.count ?? 0).toString()}
          detail="Mirrored repositories are now available as shared shell context via the status endpoint."
          icon={FolderKanbanIcon}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Surface className="p-6">
          <p className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
            Integration posture
          </p>
          <div className="mt-5 grid gap-3">
            {integrations.map(([key, integration]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-3 border border-border/70 bg-background/55 px-4 py-3 text-sm"
                  >
                    <div>
                      <p className="capitalize text-foreground">{key.replace(/([A-Z])/g, " $1")}</p>
                      <p className="text-muted-foreground">{integration.type}</p>
                    </div>
                    <span className="text-[10px] uppercase tracking-[0.24em] text-emerald-600 dark:text-emerald-300">
                      {integration.status}
                    </span>
                  </div>
                ))}
          </div>
        </Surface>

        <Surface className="p-6">
          <p className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
            Repo coverage
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {(status?.repos.keys ?? []).length ? (
              (status?.repos.keys ?? []).map((repoKey: string) => (
                <span
                  key={repoKey}
                  className="inline-flex items-center rounded-none border border-border/70 bg-background/55 px-3 py-2 text-xs text-foreground"
                >
                  {repoKey}
                </span>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No repos registered yet.</p>
            )}
          </div>
        </Surface>
      </div>
    </div>
  )
}
