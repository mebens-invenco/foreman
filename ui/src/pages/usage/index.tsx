import { useMemo, useState } from "react"

import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useUsageQuery } from "@/hooks/use-usage-query"
import { formatUsd } from "@/lib/cost"
import { formatShortNumber } from "@/lib/format"
import type { UsageBucket, UsageGroupBy } from "@/lib/api"

const groupByOptions: Array<{ value: UsageGroupBy; label: string; columnLabel: string }> = [
  { value: "day", label: "By day", columnLabel: "Day" },
  { value: "runner", label: "By runner", columnLabel: "Runner" },
  { value: "model", label: "By runner/model", columnLabel: "Runner / model" },
]

const defaultWindow = () => {
  const today = new Date()
  const todayKey = today.toISOString().slice(0, 10)
  const sevenDaysAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
  const fromKey = sevenDaysAgo.toISOString().slice(0, 10)
  return { from: fromKey, to: todayKey }
}

function UsageRow({
  bucket,
  columnLabel,
  emphasize,
}: {
  bucket: UsageBucket
  columnLabel: string
  emphasize?: boolean
}) {
  return (
    <tr className={emphasize ? "bg-muted/40 font-medium" : undefined}>
      <td className="px-3 py-2 text-xs text-foreground">
        {emphasize ? "Total" : bucket.groupKey}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
        {bucket.attemptsCount}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
        {formatShortNumber(bucket.tokens.inputTokens)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
        {formatShortNumber(bucket.tokens.outputTokens)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
        {formatShortNumber(bucket.tokens.cacheReadInputTokens)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
        {formatShortNumber(bucket.tokens.cacheCreationInputTokens)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-foreground">
        {formatUsd(bucket.cost.totalUsd)}
      </td>
    </tr>
  )
  // The column label argument is passed through so a future per-grouping
  // column header tweak (e.g. badge instead of plain text) only needs to
  // change this component, not its caller.
  void columnLabel
}

export function UsagePage() {
  const window = defaultWindow()
  const [from, setFrom] = useState<string>(window.from)
  const [to, setTo] = useState<string>(window.to)
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("day")

  const params = useMemo(() => ({ from, to, groupBy }), [from, to, groupBy])
  const { data, isLoading, isError, error } = useUsageQuery(params)

  const columnLabel = groupByOptions.find((option) => option.value === groupBy)?.columnLabel ?? "Group"

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-2">
        <h2 className="text-3xl tracking-tight text-foreground">Usage</h2>
        <p className="text-sm text-muted-foreground">
          Per-attempt token usage with USD cost computed at read time from
          the hardcoded rate table. Cache reads dominate volume but are
          billed at 10% of input — both are surfaced here.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3 border border-border/70 bg-background/70 px-4 py-3">
        <label className="flex flex-col gap-1 text-xxs tracking-[0.22em] text-muted-foreground uppercase">
          From
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1 text-xxs tracking-[0.22em] text-muted-foreground uppercase">
          To
          <Input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="w-40"
          />
        </label>
        <label className="flex flex-col gap-1 text-xxs tracking-[0.22em] text-muted-foreground uppercase">
          Group by
          <Select value={groupBy} onValueChange={(value) => setGroupBy(value as UsageGroupBy)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groupByOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="border border-border/70 bg-background/70">
        {isLoading ? (
          <div className="space-y-2 px-4 py-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : isError ? (
          <div className="border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            {error instanceof Error ? error.message : "Failed to load usage."}
          </div>
        ) : data ? (
          <table className="w-full table-auto border-collapse">
            <thead>
              <tr className="border-b border-border/70 text-xxs tracking-[0.22em] text-muted-foreground uppercase">
                <th className="px-3 py-2 text-left">{columnLabel}</th>
                <th className="px-3 py-2 text-right">Attempts</th>
                <th className="px-3 py-2 text-right">Fresh in</th>
                <th className="px-3 py-2 text-right">Output</th>
                <th className="px-3 py-2 text-right">Cache read</th>
                <th className="px-3 py-2 text-right">Cache write</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No attempts recorded in this window.
                  </td>
                </tr>
              ) : (
                data.buckets.map((bucket) => (
                  <UsageRow key={bucket.groupKey} bucket={bucket} columnLabel={columnLabel} />
                ))
              )}
              {data.buckets.length > 0 ? (
                <UsageRow bucket={data.totals} columnLabel={columnLabel} emphasize />
              ) : null}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}
