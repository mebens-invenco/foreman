import { useQuery } from "@tanstack/react-query"

import { listHistory } from "@/lib/api"

export const historyQueryKey = ["foreman", "overview", "history"] as const

export function useHistoryQuery(limit = 12) {
  return useQuery({
    queryKey: [...historyQueryKey, limit],
    queryFn: () => listHistory({ limit }),
    refetchInterval: 10_000,
  })
}
