import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { listForemanTasks, setAgentEnabled, type ForemanTask } from "@/lib/api"

export const foremanTasksQueryKey = ["foreman", "tasks", "manager"] as const

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function useForemanTasksQuery() {
  return useQuery({
    queryKey: foremanTasksQueryKey,
    queryFn: listForemanTasks,
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
      await queryClient.cancelQueries({ queryKey: foremanTasksQueryKey })
      const previous = queryClient.getQueryData<ForemanTask[]>(foremanTasksQueryKey)
      if (previous) {
        queryClient.setQueryData<ForemanTask[]>(
          foremanTasksQueryKey,
          previous.map((task) =>
            task.id === taskId ? { ...task, agentEnabled: enabled } : task
          )
        )
      }
      return { previous }
    },
    onError: (
      error: unknown,
      _variables: AgentEnabledVariables,
      context: { previous: ForemanTask[] | undefined } | undefined
    ) => {
      if (context?.previous) {
        queryClient.setQueryData(foremanTasksQueryKey, context.previous)
      }
      toast.error(messageFromError(error, "Could not update Foreman for this issue."))
    },
    // Refetch on settle so labels and frontmatter re-derive from the server
    // rather than trusting the optimistic guess.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: foremanTasksQueryKey })
    },
  })
}
