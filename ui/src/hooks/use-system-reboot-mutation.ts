import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { rebootSystem } from "@/lib/api"

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function useSystemRebootMutation() {
  return useMutation({
    mutationFn: rebootSystem,
    onSuccess: () => {
      toast.success("Foreman is restarting. The page may disconnect briefly.")
    },
    onError: (error: unknown) => {
      toast.error(messageFromError(error, "Could not restart Foreman."))
    },
  })
}
