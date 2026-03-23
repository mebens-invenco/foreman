import { useQuery } from "@tanstack/react-query"

import { getStatus } from "@/lib/api"

export const statusQueryKey = ["foreman", "status"] as const

export function useStatusQuery() {
  return useQuery({
    queryKey: statusQueryKey,
    queryFn: getStatus,
    refetchInterval: 10_000,
  })
}
