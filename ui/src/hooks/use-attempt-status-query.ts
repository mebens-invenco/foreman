import { useQuery } from "@tanstack/react-query"

import {
  getAttemptActivity,
  getAttemptStatus,
  getWorkerStatus,
} from "@/lib/api"

export function attemptStatusQueryKey(attemptId: string | null) {
  return ["foreman", "attempt-status", attemptId] as const
}

export function attemptActivityQueryKey(
  attemptId: string | null,
  params: { afterSeq?: number; limit?: number } = {},
) {
  return ["foreman", "attempt-activity", attemptId, params] as const
}

export function workerStatusQueryKey(workerId: string | null) {
  return ["foreman", "worker-status", workerId] as const
}

export function useAttemptStatusQuery(
  attemptId: string | null,
  options: { refetchInterval?: number | false; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: attemptStatusQueryKey(attemptId),
    queryFn: () => getAttemptStatus(attemptId!),
    enabled: Boolean(attemptId) && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? 5_000,
  })
}

export function useAttemptActivityQuery(
  attemptId: string | null,
  params: { afterSeq?: number; limit?: number } = {},
  options: { refetchInterval?: number | false; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: attemptActivityQueryKey(attemptId, params),
    queryFn: () => getAttemptActivity(attemptId!, params),
    enabled: Boolean(attemptId) && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? 5_000,
  })
}

export function useWorkerStatusQuery(
  workerId: string | null,
  options: { refetchInterval?: number | false; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: workerStatusQueryKey(workerId),
    queryFn: () => getWorkerStatus(workerId!),
    enabled: Boolean(workerId) && (options.enabled ?? true),
    refetchInterval: options.refetchInterval ?? 5_000,
  })
}
