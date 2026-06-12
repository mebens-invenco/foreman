import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { listAttempts, stopAttempt } from "@/lib/api"
import { workersQueryKey } from "@/hooks/use-workers-query"

export const attemptsQueryKey = ["foreman", "attempts"] as const

export function attemptDetailQueryKey(attemptId: string | null) {
  return ["foreman", "attempt", attemptId] as const
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function useAttemptsQuery(params?: {
  limit?: number
  taskId?: string
  enabled?: boolean
}) {
  const limit = params?.limit
  const taskId = params?.taskId
  const enabled = params?.enabled ?? true
  return useQuery({
    queryKey: [...attemptsQueryKey, limit ?? "all", taskId ?? "all"],
    queryFn: () => listAttempts({ limit, taskId }),
    refetchInterval: 10_000,
    enabled,
  })
}

export function useStopAttemptMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: stopAttempt,
    onSuccess: async (_response, attemptId) => {
      toast.success("Attempt stop requested.")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workersQueryKey }),
        queryClient.invalidateQueries({ queryKey: attemptsQueryKey }),
        queryClient.invalidateQueries({
          queryKey: attemptDetailQueryKey(attemptId),
        }),
      ])
    },
    onError: (error: unknown) => {
      toast.error(messageFromError(error, "Could not stop the attempt."))
    },
  })
}
