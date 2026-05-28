import { useQuery } from "@tanstack/react-query"

import { getUsage, type UsageGroupBy } from "@/lib/api"

export const usageQueryKey = (params: {
  from?: string
  to?: string
  groupBy: UsageGroupBy
}) => ["foreman", "usage", params.from ?? "default", params.to ?? "default", params.groupBy] as const

export function useUsageQuery(params: {
  from?: string
  to?: string
  groupBy: UsageGroupBy
}) {
  return useQuery({
    queryKey: usageQueryKey(params),
    queryFn: () => getUsage(params),
    refetchInterval: 30_000,
  })
}
