import type { AttemptRecord, WorkItemBucket } from "@/lib/api"

export function bucketTokensTotal(bucket: WorkItemBucket): number {
  const { tokens } = bucket
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheReadInputTokens +
    tokens.cacheCreationInputTokens +
    tokens.reasoningOutputTokens
  )
}

export function sortAttemptsNewestFirst(
  attempts: AttemptRecord[]
): AttemptRecord[] {
  return [...attempts].sort((a, b) => {
    const aTime = new Date(a.startedAt).getTime()
    const bTime = new Date(b.startedAt).getTime()
    if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
      return 0
    }
    return bTime - aTime
  })
}

export function attemptsPagePath(taskId: string, attemptId: string): string {
  const params = new URLSearchParams({ taskId, attemptId })
  return `/attempts?${params.toString()}`
}
