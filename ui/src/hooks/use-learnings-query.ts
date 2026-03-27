import { useQuery } from "@tanstack/react-query"

import { listLearnings } from "@/lib/api"

export const learningsQueryKey = ["foreman", "learnings"] as const

export function useLearningsQuery(limit?: number) {
  return useQuery({
    queryKey: [...learningsQueryKey, limit ?? "all"],
    queryFn: () => listLearnings({ limit }),
    refetchInterval: 10_000,
  })
}
