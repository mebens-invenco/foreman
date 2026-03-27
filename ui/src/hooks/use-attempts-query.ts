import { useQuery } from "@tanstack/react-query"

import { listAttempts } from "@/lib/api"

export const attemptsQueryKey = ["foreman", "attempts"] as const

export function useAttemptsQuery(limit?: number) {
  return useQuery({
    queryKey: [...attemptsQueryKey, limit ?? "all"],
    queryFn: () => listAttempts({ limit }),
    refetchInterval: 10_000,
  })
}
