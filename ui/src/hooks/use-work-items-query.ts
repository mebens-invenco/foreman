import { useQuery } from "@tanstack/react-query"

import { getWorkItems, type AttemptStatus } from "@/lib/api"

export type WorkItemsQueryParams = {
  from?: string
  to?: string
  status?: AttemptStatus
  search?: string
}

export const workItemsQueryKey = (params: WorkItemsQueryParams) =>
  [
    "foreman",
    "work-items",
    params.from ?? "default",
    params.to ?? "default",
    params.status ?? "all",
    params.search ?? "",
  ] as const

export function useWorkItemsQuery(params: WorkItemsQueryParams) {
  return useQuery({
    queryKey: workItemsQueryKey(params),
    queryFn: () => getWorkItems(params),
    refetchInterval: 30_000,
  })
}
