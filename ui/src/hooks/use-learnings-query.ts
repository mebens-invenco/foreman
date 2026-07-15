import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { listLearnings, setLearningArchived, type LearningRecord } from "@/lib/api"

export const learningsQueryKey = ["foreman", "learnings"] as const

export function useLearningsQuery(limit?: number) {
  return useQuery({
    queryKey: [...learningsQueryKey, limit ?? "all"],
    queryFn: () => listLearnings({ limit }),
    refetchInterval: 10_000,
  })
}

type ArchiveVariables = { id: string; archived: boolean }

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

// Optimistically flip archivedAt, reconcile on settle. The archive can fail
// (unknown id), so the error must surface rather than be swallowed.
export function useSetLearningArchivedMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, archived }: ArchiveVariables) =>
      setLearningArchived(id, archived),
    onMutate: async ({ id, archived }: ArchiveVariables) => {
      await queryClient.cancelQueries({ queryKey: learningsQueryKey })
      const previous = queryClient.getQueriesData<LearningRecord[]>({
        queryKey: learningsQueryKey,
      })
      queryClient.setQueriesData<LearningRecord[]>(
        { queryKey: learningsQueryKey },
        (learnings) =>
          learnings?.map((learning) =>
            learning.id === id
              ? {
                  ...learning,
                  archivedAt: archived
                    ? (learning.archivedAt ?? new Date().toISOString())
                    : null,
                }
              : learning
          )
      )
      return { previous }
    },
    onError: (
      error: unknown,
      _variables: ArchiveVariables,
      context:
        | { previous: [readonly unknown[], LearningRecord[] | undefined][] }
        | undefined
    ) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data)
      }
      toast.error(messageFromError(error, "Could not update the learning."))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: learningsQueryKey })
    },
  })
}
