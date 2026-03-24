import { useEffect, useState } from "react"

import {
  MoonStarIcon,
  PlayIcon,
  SunMediumIcon,
  PauseIcon,
  SquareIcon,
  RadarIcon,
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useScoutRunsQuery } from "@/hooks/use-scout-runs-query"
import { useRunScoutMutation, useSchedulerActionMutation } from "@/hooks/use-scheduler-actions"
import { useStatusQuery } from "@/hooks/use-status-query"
import { cn } from "@/lib/utils"

function ThemeToggleButton() {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  const Icon = isDark ? SunMediumIcon : MoonStarIcon
  const label = isDark ? "Switch to light mode" : "Switch to dark mode"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          onClick={() => setTheme(isDark ? "light" : "dark")}
        >
          <Icon className="size-4" />
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function statusTone(status: string) {
  switch (status) {
    case "running":
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "paused":
      return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    case "stopping":
      return "border-orange-500/35 bg-orange-500/10 text-orange-700 dark:text-orange-300"
    default:
      return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"
  }
}

function ControlButton({
  label,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function formatCountdown(targetAt: string, now: number) {
  const target = new Date(targetAt).getTime()
  if (Number.isNaN(target)) {
    return null
  }

  const seconds = Math.max(0, Math.ceil((target - now) / 1000))
  if (seconds <= 0) {
    return "Next poll imminent"
  }
  if (seconds < 60) {
    return `Next poll in ${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  const remainderSeconds = seconds % 60
  if (minutes < 60) {
    return remainderSeconds > 0
      ? `Next poll in ${minutes}m ${remainderSeconds}s`
      : `Next poll in ${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainderMinutes = minutes % 60
  return remainderMinutes > 0
    ? `Next poll in ${hours}h ${remainderMinutes}m`
    : `Next poll in ${hours}h`
}

export function ShellTopBar() {
  const { data: status } = useStatusQuery()
  const { data: scoutRuns = [] } = useScoutRunsQuery()
  const [now, setNow] = useState(() => Date.now())
  const startScheduler = useSchedulerActionMutation("start")
  const pauseScheduler = useSchedulerActionMutation("pause")
  const stopScheduler = useSchedulerActionMutation("stop")
  const runScout = useRunScoutMutation()

  const schedulerStatus = status?.scheduler.status ?? "stopped"
  const schedulerRunning = schedulerStatus === "running"
  const latestScoutRun = scoutRuns[0] ?? null
  const scoutRunning = runScout.isPending || latestScoutRun?.status === "running"
  const scoutTooltip = scoutRunning
    ? "Scout run in progress"
    : schedulerStatus === "running" && status?.scheduler.nextScoutPollAt
      ? formatCountdown(status.scheduler.nextScoutPollAt, now) ?? "Next poll scheduled"
      : schedulerStatus === "paused"
        ? "No poll scheduled while paused"
        : schedulerStatus === "stopping"
          ? "Scheduler is stopping"
          : "Scheduler stopped"
  const anyPending =
    startScheduler.isPending ||
    pauseScheduler.isPending ||
    stopScheduler.isPending ||
    runScout.isPending

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(interval)
    }
  }, [])

  return (
    <header className="sticky top-0 z-20 border-b border-border/70 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <SidebarTrigger className="shrink-0" />
          <span
            className={cn(
              "inline-flex items-center rounded-none border px-2 py-1 text-[10px] font-medium uppercase tracking-[0.24em]",
              statusTone(schedulerStatus)
            )}
          >
            {schedulerStatus}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => runScout.mutate()}
                  disabled={anyPending || schedulerStatus === "stopping" || scoutRunning}
                >
                  <RadarIcon className={cn("size-3.5", scoutRunning && "animate-spin")} />
                  Scout
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{scoutTooltip}</TooltipContent>
          </Tooltip>
          <ControlButton
            label={schedulerRunning ? "Pause scheduler" : "Start scheduler"}
            size="icon-sm"
            variant="default"
            onClick={() => {
              if (schedulerRunning) {
                pauseScheduler.mutate()
                return
              }

              startScheduler.mutate()
            }}
            disabled={anyPending || schedulerStatus === "stopping"}
          >
            {schedulerRunning ? (
              <PauseIcon className="size-3.5" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
            <span className="sr-only">
              {schedulerRunning ? "Pause scheduler" : "Start scheduler"}
            </span>
          </ControlButton>
          <ControlButton
            label="Stop scheduler"
            size="icon-sm"
            variant="outline"
            onClick={() => stopScheduler.mutate()}
            disabled={anyPending || schedulerStatus === "stopped" || schedulerStatus === "stopping"}
          >
            <SquareIcon className="size-3.5" />
            <span className="sr-only">Stop scheduler</span>
          </ControlButton>
          <ThemeToggleButton />
        </div>
      </div>
    </header>
  )
}
