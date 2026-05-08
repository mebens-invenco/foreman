import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { statusQueryKey } from "@/hooks/use-status-query"
import {
  getSettings,
  patchSettings,
  type SettingsPatch,
  type SettingsResponse,
} from "@/lib/api"

export const settingsQueryKey = ["foreman", "settings"] as const

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergePatch<T>(target: T, patch: SettingsPatch): T {
  if (!isRecord(target) || !isRecord(patch)) {
    return patch as T
  }

  const merged: Record<string, unknown> = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue
    }
    merged[key] = isRecord(value)
      ? mergePatch(merged[key], value as SettingsPatch)
      : value
  }
  return merged as T
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
    onMutate: async (patch: SettingsPatch) => {
      await queryClient.cancelQueries({ queryKey: settingsQueryKey })
      const previous = queryClient.getQueryData<SettingsResponse>(settingsQueryKey)
      if (previous) {
        queryClient.setQueryData<SettingsResponse>(settingsQueryKey, {
          config: mergePatch(previous.config, patch),
        })
      }
      return { previous }
    },
    onSuccess: async (settings: SettingsResponse) => {
      queryClient.setQueryData(settingsQueryKey, settings)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: settingsQueryKey }),
        queryClient.invalidateQueries({ queryKey: statusQueryKey }),
      ])
    },
    onError: (error: unknown, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(settingsQueryKey, context.previous)
      }
      toast.error(messageFromError(error, "Could not save settings."))
    },
  })
}
