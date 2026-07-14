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
 * A candidate and the similarity it was selected on. Two selectors below produce
 * this, gated on different questions — which gate admitted a candidate is the
 * producing selector's business, and each states its own.
 */
export type CosineCandidate = {
  id: string;
  /** The raw cosine similarity this candidate was selected on, reported rather than discarded. */
  similarity: number;
};

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
): CosineCandidate[] => {
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
    .map((candidate) => ({ id: candidate.id, similarity: candidate.similarity }));
};

/**
 * The learnings sitting at or above `gate.minSimilarity` from the query, closest
 * first — the same geometry `selectCosineCandidates` reads, gated on the other
 * question you can ask of it.
 *
 * z asks "did this stand out from the corpus", which is the right question for
 * RANKING and the wrong one for deciding whether a learning is close enough to PUSH
 * at a caller who never asked. The two disagree hardest exactly where it matters:
 * against a homogeneous corpus an on-topic query is broadly similar to everything,
 * so nothing stands out and the z gate proposes nothing, while an off-topic query
 * finds a lucky outlier in a low, tight distribution and the z gate proposes it.
 * Gating injection on z therefore hid learnings it would have happily admitted —
 * measured on the committed calibration vectors, a real foreman ticket held 50
 * learnings above the injection floor and the z gate proposed none of them.
 *
 * So there is no zero-variance early return and no `n < 2` guard here. Both are
 * artifacts of z, which needs spread to exist and divides by it: a corpus whose
 * similarities are all identical has no outlier, but it may still be uniformly
 * close, and "is this close" is answerable of a single learning. Only the floor
 * decides.
 *
 * `gate.limit` is the caller's, not `COSINE_TOP_K`: this list does not pad a fusion
 * window, so the bound that keeps the dense arm from crowding out bm25 is not the
 * bound that belongs here. It stays a cap, never a quota — a query with two
 * admissible learnings gets two.
 */
export const selectSimilarCandidates = (
  queryVector: Float32Array,
  embeddings: readonly { learningId: string; vector: Float32Array }[],
  gate: { minSimilarity: number; limit: number },
): CosineCandidate[] =>
  embeddings
    .map((embedding) => ({ id: embedding.learningId, similarity: cosineSimilarity(queryVector, embedding.vector) }))
    .filter((candidate) => candidate.similarity >= gate.minSimilarity)
    .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
    .slice(0, gate.limit);
