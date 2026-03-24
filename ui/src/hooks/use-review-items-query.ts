import { useQuery } from "@tanstack/react-query"

import { listTasks } from "@/lib/api"

export const reviewItemsQueryKey = ["foreman", "overview", "review-items"] as const

export function useReviewItemsQuery() {
  return useQuery({
    queryKey: reviewItemsQueryKey,
    queryFn: () => listTasks({ state: "in_review" }),
    refetchInterval: 10_000,
  })
}
