import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { listForemanTasks, setAgentEnabled, type ForemanTask } from "@/lib/api"
import type { ForemanScope } from "@/pages/foreman/foreman-helpers"

// Prefix shared by every scope's cache entry. The mutation operates on the
// prefix so an optimistic toggle/rollback/invalidate reconciles whichever scope
// (candidates or assigned) is currently mounted.
export const foremanTasksQueryKeyPrefix = ["foreman", "tasks", "manager"] as const
export const foremanTasksQueryKey = (scope: ForemanScope) =>
  [...foremanTasksQueryKeyPrefix, scope] as const

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function useForemanTasksQuery(scope: ForemanScope) {
  return useQuery({
    queryKey: foremanTasksQueryKey(scope),
    queryFn: () => listForemanTasks(scope),
    refetchInterval: 30_000,
  })
}

type AgentEnabledVariables = { taskId: string; enabled: boolean }

// Optimistically flip the row, reconcile on the response, and roll back + toast
// on failure — the underlying label mutation can fail (unknown task, exclude
// labels unconfigured), so the error must never be swallowed.
export function useSetAgentEnabledMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, enabled }: AgentEnabledVariables) =>
      setAgentEnabled(taskId, enabled),
    onMutate: async ({ taskId, enabled }: AgentEnabledVariables) => {
      await queryClient.cancelQueries({ queryKey: foremanTasksQueryKeyPrefix })
      // Snapshot every scope cache so a failure rolls each one back.
      const previous = queryClient.getQueriesData<ForemanTask[]>({
        queryKey: foremanTasksQueryKeyPrefix,
      })
      queryClient.setQueriesData<ForemanTask[]>(
        { queryKey: foremanTasksQueryKeyPrefix },
        (tasks) =>
          tasks?.map((task) =>
            task.id === taskId ? { ...task, agentEnabled: enabled } : task
          )
      )
      return { previous }
    },
    onError: (
      error: unknown,
      _variables: AgentEnabledVariables,
      context: { previous: [readonly unknown[], ForemanTask[] | undefined][] } | undefined
    ) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data)
      }
      toast.error(messageFromError(error, "Could not update Foreman for this issue."))
    },
    // Refetch on settle so labels and frontmatter re-derive from the server
    // rather than trusting the optimistic guess.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: foremanTasksQueryKeyPrefix })
    },
  })
}
