import { useQuery } from "@tanstack/react-query"

import { listWorkers } from "@/lib/api"

export const workersQueryKey = ["foreman", "workers"] as const

export function useWorkersQuery() {
  return useQuery({
    queryKey: workersQueryKey,
    queryFn: listWorkers,
    refetchInterval: 5_000,
  })
}
