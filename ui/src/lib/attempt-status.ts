import type { AttemptStatus } from "@/lib/api"

export function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

export function statusTone(status: AttemptStatus) {
  switch (status) {
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "failed":
    case "blocked":
      return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
    case "canceled":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    default:
      return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300"
  }
}
