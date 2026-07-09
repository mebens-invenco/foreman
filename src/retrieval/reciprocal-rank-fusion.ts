/**
 * Damping constant from Cormack et al. (2009). Large relative to the ranks that
 * matter, so no single list can dominate the fusion on the strength of one
 * top-ranked hit.
 */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: `score(id) = Σ 1/(k + rank)` over every list the id
 * appears in, rank being 1-based. Ids absent from a list contribute nothing.
 *
 * Fusion reads ranks, never scores, which is the whole point here: bm25 is
 * negative and unbounded while cosine is [-1, 1], so there is no score scale to
 * calibrate between them. Higher fused score is better — the inverse of raw
 * bm25, where more negative wins.
 */
export const fuseByReciprocalRank = (rankedLists: readonly (readonly string[])[], k: number = RRF_K): Map<string, number> => {
  const fused = new Map<string, number>();
  for (const rankedIds of rankedLists) {
    rankedIds.forEach((id, index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }

  return fused;
};
