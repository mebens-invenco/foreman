import { cosineSimilarity } from "./cosine-similarity.js";

/**
 * Hard cap on how many learnings the cosine arm may propose for one query.
 * Bounds how far a dense ranking can pad the result window when bm25 is silent.
 */
export const COSINE_TOP_K = 10;

/**
 * A candidate must sit this many standard deviations above the mean similarity
 * of the query against the in-scope corpus.
 *
 * It is a RELATIVE bar, not an absolute one, because bge-small's similarity
 * scale is far too compressed for a fixed floor: measured over the bench corpus,
 * genuinely relevant pairs sit at p05 0.518 / p50 0.590, while an unrelated
 * query's nearest neighbour still scores 0.637. Any absolute floor that rejects
 * the latter discards most of the former.
 *
 * 2.0 was chosen by sweeping the bench: it is the value at which a semantics-free
 * embedder (`FakeEmbedder`) stops lifting recall over the FTS baseline at all,
 * while the real model's recall@5 and MRR both improve over the unbounded arm.
 * Below it the fusion starts scoring lottery tickets; above it real matches are lost.
 */
export const COSINE_Z_FLOOR = 2.0;

/**
 * The learnings whose embeddings stand out from the corpus for this query,
 * best first — a bounded candidate list, the shape RRF expects from a retriever.
 *
 * This is deliberately NOT a total ranking of the corpus. A dense ranking always
 * has a rank 1, so fusing one would hand every embedded learning a nonzero RRF
 * score and make an empty result impossible; the top of the window would fill
 * with arbitrary rows whenever bm25 found nothing.
 *
 * A standard deviation needs spread to mean anything, so the arm falls silent on
 * a corpus too small to have an outlier: with `n` embeddings the largest
 * attainable z is `(n - 1) / sqrt(n)`, which stays under 2.0 until n reaches 6
 * (1.79 at n = 5, 2.04 at n = 6). That is the intended behaviour during a partial
 * backfill — a handful of embedded rows must not outrank the unembedded majority
 * they are drowning in.
 *
 * That bound is the SAMPLE standard deviation's, which is why the variance below
 * divides by `n - 1`. Dividing by `n` instead would bound z at `sqrt(n - 1)`,
 * putting n = 5 at exactly 2.0 — flush against the floor, where whether the arm
 * fires comes down to floating-point rounding rather than to the rule.
 */
export const selectCosineCandidates = (
  queryVector: Float32Array,
  embeddings: readonly { learningId: string; vector: Float32Array }[],
): string[] => {
  // A single embedding has no spread to be an outlier against, and the sample
  // variance below would divide by zero.
  if (embeddings.length < 2) {
    return [];
  }

  const scored = embeddings.map((embedding) => ({
    id: embedding.learningId,
    similarity: cosineSimilarity(queryVector, embedding.vector),
  }));

  const mean = scored.reduce((total, candidate) => total + candidate.similarity, 0) / scored.length;
  const variance = scored.reduce((total, candidate) => total + (candidate.similarity - mean) ** 2, 0) / (scored.length - 1);
  const standardDeviation = Math.sqrt(variance);

  // Every similarity identical: no outlier exists, and dividing by zero would
  // hand every row an infinite z.
  if (standardDeviation === 0) {
    return [];
  }

  return scored
    .filter((candidate) => (candidate.similarity - mean) / standardDeviation >= COSINE_Z_FLOOR)
    .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
    .slice(0, COSINE_TOP_K)
    .map((candidate) => candidate.id);
};
