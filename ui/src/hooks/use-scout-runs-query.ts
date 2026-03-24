import { useQuery } from "@tanstack/react-query"

import { listScoutRuns } from "@/lib/api"

export const scoutRunsQueryKey = ["foreman", "scout-runs"] as const

export function useScoutRunsQuery() {
  return useQuery({
    queryKey: scoutRunsQueryKey,
    queryFn: listScoutRuns,
    refetchInterval: 5_000,
  })
}
