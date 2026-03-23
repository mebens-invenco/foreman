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

export function ShellTopBar() {
  const { data: status } = useStatusQuery()
  const startScheduler = useSchedulerActionMutation("start")
  const pauseScheduler = useSchedulerActionMutation("pause")
  const stopScheduler = useSchedulerActionMutation("stop")
  const runScout = useRunScoutMutation()

  const schedulerStatus = status?.scheduler.status ?? "stopped"
  const anyPending =
    startScheduler.isPending ||
    pauseScheduler.isPending ||
    stopScheduler.isPending ||
    runScout.isPending

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
          <Button
            size="sm"
            variant="outline"
            onClick={() => runScout.mutate()}
            disabled={anyPending || schedulerStatus === "stopping"}
          >
            <RadarIcon className="size-3.5" />
            Scout
          </Button>
          <ControlButton
            label="Start scheduler"
            size="icon-sm"
            variant={schedulerStatus === "running" ? "outline" : "default"}
            onClick={() => startScheduler.mutate()}
            disabled={anyPending || schedulerStatus === "running"}
          >
            <PlayIcon className="size-3.5" />
            <span className="sr-only">Start scheduler</span>
          </ControlButton>
          <ControlButton
            label="Pause scheduler"
            size="icon-sm"
            variant={schedulerStatus === "running" ? "default" : "outline"}
            onClick={() => pauseScheduler.mutate()}
            disabled={anyPending || schedulerStatus !== "running"}
          >
            <PauseIcon className="size-3.5" />
            <span className="sr-only">Pause scheduler</span>
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
