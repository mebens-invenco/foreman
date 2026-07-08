// Pure scoring for the retrieval bench. No I/O, no DB — just the recall@k / MRR
// math, so it can be unit-tested on synthetic ranked lists. The semantics mirror
// the prototype `baseline.mjs` exactly, so the committed baseline reproduces.

/**
 * Per-case retrieval scores, computed on the ranked result ids a single case's
 * queries produced against its expected (consensus-labeled) ids. Kept raw
 * (unrounded) so the aggregate can average before rounding — matching the
 * baseline, which sums raw per-case values.
 */
export interface CaseScore {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
}

/**
 * Aggregate metrics over the labeled cases. Field names and rounding mirror the
 * prototype baseline runner so the committed numbers reproduce byte-for-byte.
 */
export interface BenchMetrics {
  labeledCases: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  zeroRecallCases: number;
}

// recall@k = |expected ∩ top-k| / |expected|. Caller guarantees expected is
// non-empty (only labeled cases are scored), so the division is well-defined.
const recallAtK = (rankedIds: readonly string[], expected: ReadonlySet<string>, k: number): number =>
  rankedIds.slice(0, k).filter((id) => expected.has(id)).length / expected.size;

/**
 * Score one case's ranked results against its expected ids.
 * - recall@k = fraction of expected ids present in the top k.
 * - MRR = 1 / (1-based rank of the first expected hit), or 0 when no expected id
 *   appears anywhere in the ranked list.
 * `expectedIds` is deduplicated internally (a Set), matching the baseline.
 */
export const scoreCase = (rankedIds: readonly string[], expectedIds: readonly string[]): CaseScore => {
  const expected = new Set(expectedIds);
  const firstRank = rankedIds.findIndex((id) => expected.has(id));
  return {
    recallAt5: recallAtK(rankedIds, expected, 5),
    recallAt10: recallAtK(rankedIds, expected, 10),
    mrr: firstRank === -1 ? 0 : 1 / (firstRank + 1),
  };
};

const round3 = (value: number): number => Number(value.toFixed(3));

/**
 * Average the per-case scores into the bench metrics. recall/MRR are averaged
 * over the raw per-case values then rounded to 3dp (baseline parity).
 * `zeroRecallCases` counts cases with no expected hit in the top 10.
 */
export const aggregateMetrics = (scores: readonly CaseScore[]): BenchMetrics => {
  const n = scores.length;
  const totals = scores.reduce(
    (acc, score) => ({ r5: acc.r5 + score.recallAt5, r10: acc.r10 + score.recallAt10, mrr: acc.mrr + score.mrr }),
    { r5: 0, r10: 0, mrr: 0 },
  );
  return {
    labeledCases: n,
    recallAt5: n === 0 ? 0 : round3(totals.r5 / n),
    recallAt10: n === 0 ? 0 : round3(totals.r10 / n),
    mrr: n === 0 ? 0 : round3(totals.mrr / n),
    zeroRecallCases: scores.filter((score) => score.recallAt10 === 0).length,
  };
};
