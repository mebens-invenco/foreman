import { useQuery } from "@tanstack/react-query"

import { listHistory } from "@/lib/api"

export const historyQueryKey = ["foreman", "history"] as const

export function useHistoryQuery(limit?: number) {
  return useQuery({
    queryKey: [...historyQueryKey, limit ?? "all"],
    queryFn: () => listHistory({ limit }),
    refetchInterval: 10_000,
  })
}
