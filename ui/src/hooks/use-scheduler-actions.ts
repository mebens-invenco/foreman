import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  pauseScheduler,
  runScout,
  startScheduler,
  stopScheduler,
  type SchedulerStatus,
} from "@/lib/api"
import { statusQueryKey } from "@/hooks/use-status-query"

type SchedulerAction = "start" | "pause" | "stop"

const schedulerMutations: Record<
  SchedulerAction,
  {
    mutationFn: () => Promise<{ scheduler: { status: SchedulerStatus } }>
    successMessage: string
    errorMessage: string
  }
> = {
  start: {
    mutationFn: startScheduler,
    successMessage: "Scheduler started.",
    errorMessage: "Could not start the scheduler.",
  },
  pause: {
    mutationFn: pauseScheduler,
    successMessage: "Scheduler paused.",
    errorMessage: "Could not pause the scheduler.",
  },
  stop: {
    mutationFn: stopScheduler,
    successMessage: "Scheduler stop requested.",
    errorMessage: "Could not stop the scheduler.",
  },
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function useSchedulerActionMutation(action: SchedulerAction) {
  const queryClient = useQueryClient()
  const config = schedulerMutations[action]

  return useMutation({
    mutationFn: config.mutationFn,
    onSuccess: async () => {
      toast.success(config.successMessage)
      await queryClient.invalidateQueries({ queryKey: statusQueryKey })
    },
    onError: (error: unknown) => {
      toast.error(messageFromError(error, config.errorMessage))
    },
  })
}

export function useRunScoutMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: runScout,
    onSuccess: async () => {
      toast.success("Scout run scheduled.")
      await queryClient.invalidateQueries({ queryKey: statusQueryKey })
    },
    onError: (error: unknown) => {
      toast.error(messageFromError(error, "Could not schedule a scout run."))
    },
  })
}
