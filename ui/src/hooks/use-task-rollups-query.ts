import { useQuery } from "@tanstack/react-query"

import { getTaskRollups, type AttemptStatus } from "@/lib/api"

export type TaskRollupsQueryParams = {
  from?: string
  to?: string
  status?: AttemptStatus
  search?: string
}

export const taskRollupsQueryKey = (params: TaskRollupsQueryParams) =>
  [
    "foreman",
    "task-rollups",
    params.from ?? "default",
    params.to ?? "default",
    params.status ?? "all",
    params.search ?? "",
  ] as const

export function useTaskRollupsQuery(params: TaskRollupsQueryParams) {
  return useQuery({
    queryKey: taskRollupsQueryKey(params),
    queryFn: () => getTaskRollups(params),
    refetchInterval: 30_000,
  })
}
