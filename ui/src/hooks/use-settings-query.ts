import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { statusQueryKey } from "@/hooks/use-status-query"
import { getSettings, patchSettings, type SettingsResponse } from "@/lib/api"

export const settingsQueryKey = ["foreman", "settings"] as const

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function useSettingsQuery() {
  return useQuery({
    queryKey: settingsQueryKey,
    queryFn: getSettings,
    refetchInterval: 10_000,
  })
}

export function usePatchSettingsMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: patchSettings,
    onSuccess: async (settings: SettingsResponse) => {
      queryClient.setQueryData(settingsQueryKey, settings)
      toast.success("Settings saved.")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: statusQueryKey }),
      ])
    },
    onError: (error: unknown) => {
      toast.error(messageFromError(error, "Could not save settings."))
    },
  })
}
