import { useMemo } from "react"
import { useNavigate } from "react-router"

import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { TaskLink } from "@/components/task-link"
import { useAttemptsQuery } from "@/hooks/use-attempts-query"
import { useRatesQuery } from "@/hooks/use-rates-query"
import {
  abbreviateId,
  formatActionLabel,
  formatDuration,
  formatShortNumber,
  formatTimestamp,
} from "@/lib/format"
import {
  estimateCost,
  formatUsd,
  totalAllTokenBuckets,
} from "@/lib/cost"
import { formatStatusLabel, statusTone } from "@/lib/attempt-status"
import { cn } from "@/lib/utils"
import type { AttemptRecord, WorkItemBucket } from "@/lib/api"
import {
  attemptsPagePath,
  bucketTokensTotal,
  sortAttemptsNewestFirst,
} from "@/pages/work-items/work-item-drawer-helpers"

type WorkItemDetailDrawerProps = {
  taskId: string | null
  bucket: WorkItemBucket | null
}

function StatusChip({
  status,
  prefix,
}: {
  status: AttemptRecord["status"]
  prefix?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-none border px-2 py-1 text-xxs font-medium tracking-[0.18em] uppercase",
        statusTone(status)
      )}
    >
      {prefix ? `${prefix} ` : null}
      {formatStatusLabel(status)}
    </span>
  )
}

function HeaderTotal({
  label,
  value,
  tooltip,
}: {
  label: string
  value: string
  tooltip?: string
}) {
  const body = (
    <div className="border border-border/70 bg-background/70 px-3 py-2">
      <p className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm text-foreground">{value}</p>
    </div>
  )

  if (!tooltip) {
    return body
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent sideOffset={6} className="whitespace-pre-line">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorkItemDetailDrawer({
  taskId,
  bucket,
}: WorkItemDetailDrawerProps) {
  const navigate = useNavigate()
  const { data: attempts = [], isLoading, isError, error } = useAttemptsQuery({
    taskId: taskId ?? undefined,
    enabled: taskId !== null,
  })
  const { data: rates } = useRatesQuery()

  const orderedAttempts = useMemo(
    () => sortAttemptsNewestFirst(attempts),
    [attempts]
  )

  const taskUrl = bucket?.taskUrl ?? null
  const targets = bucket?.targets ?? []
  const perTargetLatestStatus = bucket?.perTargetLatestStatus ?? []
  const tokensTotal = bucket ? bucketTokensTotal(bucket) : null
  const tokensTooltip = bucket
    ? [
        `Input: ${formatShortNumber(bucket.tokens.inputTokens)}`,
        `Output: ${formatShortNumber(bucket.tokens.outputTokens)}`,
        `Cache read: ${formatShortNumber(bucket.tokens.cacheReadInputTokens)}`,
        `Cache create: ${formatShortNumber(bucket.tokens.cacheCreationInputTokens)}`,
        bucket.tokens.reasoningOutputTokens > 0
          ? `Reasoning: ${formatShortNumber(bucket.tokens.reasoningOutputTokens)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined
  const costTooltip = bucket
    ? [
        `Input: ${formatUsd(bucket.cost.breakdown.input)}`,
        `Output: ${formatUsd(bucket.cost.breakdown.output)}`,
        `Cache read: ${formatUsd(bucket.cost.breakdown.cacheRead)}`,
        `Cache write: ${formatUsd(bucket.cost.breakdown.cacheCreate)}`,
        bucket.cost.breakdown.reasoning > 0
          ? `Reasoning: ${formatUsd(bucket.cost.breakdown.reasoning)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined

  const openAttempt = (attempt: AttemptRecord) => {
    if (!taskId) {
      return
    }
    navigate(attemptsPagePath(taskId, attempt.id))
  }

  return (
    <SheetContent
      side="right"
      className="data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:w-[min(64rem,calc(100vw-2rem))] data-[side=right]:sm:max-w-[min(64rem,calc(100vw-2rem))] data-[side=right]:xl:w-[min(78rem,calc(100vw-4rem))] data-[side=right]:xl:max-w-[min(78rem,calc(100vw-4rem))]"
    >
      <SheetHeader className="border-b border-border/70 pr-12">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <SheetTitle>Work item</SheetTitle>
              <SheetDescription className="font-mono text-xs text-muted-foreground">
                {taskId ? (
                  <TaskLink taskUrl={taskUrl}>{taskId}</TaskLink>
                ) : (
                  "No work item selected"
                )}
              </SheetDescription>
            </div>
            {bucket ? (
              <StatusChip status={bucket.effectiveStatus} />
            ) : null}
          </div>

          {targets.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
                Targets
              </span>
              {targets.map((target) => (
                <span
                  key={target}
                  className="inline-flex rounded-none border border-border/70 bg-background/70 px-2 py-1 text-xxs tracking-[0.18em] text-foreground uppercase"
                >
                  {target}
                </span>
              ))}
            </div>
          ) : null}

          {perTargetLatestStatus.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xxs tracking-[0.28em] text-muted-foreground uppercase">
                Latest status
              </span>
              {perTargetLatestStatus.map((entry) => (
                <StatusChip
                  key={entry.target}
                  status={entry.status}
                  prefix={entry.target}
                />
              ))}
            </div>
          ) : null}

          {bucket ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <HeaderTotal label="Attempts" value={`${bucket.attemptsCount}`} />
              <HeaderTotal
                label="Tokens"
                value={formatShortNumber(tokensTotal)}
                tooltip={tokensTooltip}
              />
              <HeaderTotal
                label="Cost"
                value={formatUsd(bucket.cost.totalUsd)}
                tooltip={costTooltip}
              />
              <HeaderTotal
                label="Span"
                value={formatDuration(
                  bucket.firstSeenInWindow,
                  bucket.lastFinishedAt
                )}
              />
            </div>
          ) : null}
        </div>
      </SheetHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 md:p-6">
        {isLoading ? (
          <div className="border border-border/70 bg-background/70 px-4 py-6 text-sm text-muted-foreground">
            Loading attempts...
          </div>
        ) : isError ? (
          <div className="border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            {error instanceof Error ? error.message : "Failed to load attempts."}
          </div>
        ) : orderedAttempts.length === 0 ? (
          <div className="border border-dashed border-border/70 bg-background/65 px-4 py-6 text-sm text-muted-foreground">
            No attempts recorded for this work item.
          </div>
        ) : (
          <ul className="space-y-2" data-testid="work-item-attempts-list">
            {orderedAttempts.map((attempt) => {
              const totalTokens = totalAllTokenBuckets(attempt.tokensUsed)
              const cost = estimateCost(
                attempt.tokensUsed,
                attempt.runnerName,
                attempt.runnerModel,
                rates
              )
              const summary =
                attempt.summary || attempt.errorMessage || "-"

              return (
                <li key={attempt.id}>
                  <button
                    type="button"
                    onClick={() => openAttempt(attempt)}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border border-border/70 bg-background/70 px-4 py-3 text-left hover:border-primary/40 hover:bg-primary/5 focus-visible:border-primary focus-visible:outline-none"
                  >
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="font-mono text-foreground">
                          {abbreviateId(attempt.id)}
                        </span>
                        <span>{attempt.target ?? "-"}</span>
                        <span>{formatActionLabel(attempt.stage)}</span>
                        <span>{formatTimestamp(attempt.startedAt)}</span>
                        <span>
                          {formatDuration(
                            attempt.startedAt,
                            attempt.finishedAt
                          )}
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              {formatShortNumber(totalTokens)} tokens
                            </span>
                          </TooltipTrigger>
                          <TooltipContent sideOffset={6}>
                            {cost.rateApplied
                              ? formatUsd(cost.totalUsd)
                              : `No rate for ${attempt.runnerName}/${attempt.runnerModel}`}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="truncate text-xs text-muted-foreground">
                            {summary}
                          </p>
                        </TooltipTrigger>
                        <TooltipContent
                          sideOffset={6}
                          className="max-w-md whitespace-pre-line"
                        >
                          {summary}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <StatusChip status={attempt.status} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </SheetContent>
  )
}
