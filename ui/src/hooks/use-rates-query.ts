import { useQuery } from "@tanstack/react-query"

import { getRates } from "@/lib/api"

export const ratesQueryKey = ["foreman", "rates"] as const

/**
 * Hydrates the runner+model rate table from the server so client-side cost
 * estimates use the same numbers as `/api/usage`. Rarely changes (rate
 * bumps are PR-shaped events), so refetching is generous.
 */
export function useRatesQuery() {
  return useQuery({
    queryKey: ratesQueryKey,
    queryFn: getRates,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  })
}
