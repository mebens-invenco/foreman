import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const toneByValue: Record<string, string> = {
  running: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  completed: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  done: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  proven: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  active: "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  paused: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  stopping: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  blocked: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
  failed: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
  offline: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
  timed_out: "border-rose-500/30 bg-rose-500/12 text-rose-700 dark:text-rose-300",
  canceled: "border-stone-500/25 bg-stone-500/10 text-stone-700 dark:text-stone-300",
  stopped: "border-stone-500/25 bg-stone-500/10 text-stone-700 dark:text-stone-300",
  idle: "border-stone-500/25 bg-stone-500/10 text-stone-700 dark:text-stone-300",
  ready: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
  leased: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
  review: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
  in_review: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
  established: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
  in_progress: "border-cyan-500/30 bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
  execution: "border-cyan-500/30 bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
  retry: "border-cyan-500/30 bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
  consolidation: "border-cyan-500/30 bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
  emerging: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-300",
};

const humanize = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());

type StatusBadgeProps = {
  value: string;
  label?: ReactNode;
  className?: string;
};

export function StatusBadge({ value, label, className }: StatusBadgeProps) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-[0.14em] uppercase",
        toneByValue[value] ?? "border-border/70 bg-muted/60 text-muted-foreground",
        className,
      )}
    >
      {label ?? humanize(value)}
    </Badge>
  );
}
