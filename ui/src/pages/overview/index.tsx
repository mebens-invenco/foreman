import { useEffect, useState } from "react"

import { useWorkersQuery } from "@/hooks/use-workers-query"
import { Skeleton } from "@/components/ui/skeleton"
import { WorkerCard } from "@/pages/overview/worker-card"

function useRelativeNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, intervalMs)

    return () => {
      window.clearInterval(interval)
    }
  }, [intervalMs])

  return now
}

function WorkerCardSkeleton() {
  return (
    <div className="min-h-[16rem] border border-border/70 bg-card/70 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-6 w-20" />
      </div>
      <div className="mt-6 space-y-4">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
      <Skeleton className="mt-6 h-4 w-24" />
    </div>
  )
}

export function OverviewPage() {
  const { data: workers = [], isLoading, isError, error } = useWorkersQuery()
  const now = useRelativeNow()

  if (isLoading && workers.length === 0) {
    return (
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <WorkerCardSkeleton key={`worker-card-skeleton-${index}`} />
        ))}
      </div>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {isError ? (
          <div className="border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
            {error instanceof Error ? error.message : "Failed to load workers."}
          </div>
        ) : null}

        {workers.length === 0 ? (
          <div className="border border-dashed border-border/70 bg-card/65 px-6 py-10 text-center">
            <p className="text-lg tracking-tight text-foreground">No workers available.</p>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              Worker cards will appear here once Foreman provisions active slots.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            {workers.map((worker) => (
              <WorkerCard key={worker.id} worker={worker} now={now} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
