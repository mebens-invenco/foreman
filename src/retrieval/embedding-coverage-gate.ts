import type { Embedder } from "../embeddings/embedder.js";
import { isForemanError } from "../lib/errors.js";

/**
 * Below this fraction of the in-scope corpus carrying a current vector, the cosine
 * arm sees too little of the corpus to rank it fairly: an embedded but irrelevant
 * learning collects weight that an unembedded, relevant one can never earn, so a
 * ranking can come out BELOW the FTS baseline. Presence of any vector is not
 * enough — coverage is what makes a cosine score mean anything.
 *
 * Shared by every path that reads the vector space, and deliberately so: hybrid
 * search degrades to bm25 below it and push injection injects nothing below it,
 * but both are answering "may I trust the geometry at all", and one corpus cannot
 * be trustworthy for one of them and not the other.
 */
export const MIN_EMBEDDING_COVERAGE = 0.9;

/** The line that says what to do about a corpus the cosine arm has gone blind to. */
export const embeddingShortfall = (embedder: Embedder, counts: { embeddingCount: number; learningCount: number }): string =>
  `only ${counts.embeddingCount}/${counts.learningCount} in-scope learnings carry a ${embedder.modelId} vector ` +
  `(need ${Math.round(MIN_EMBEDDING_COVERAGE * 100)}%); run \`foreman learnings backfill-embeddings\``;

/**
 * The query vectors, or the reason the caller must answer without them.
 *
 * Embeddings are an enhancement to retrieval, never a dependency of it: a model
 * that will not download and an embedder that fails to infer are outages, and a
 * degraded search must not become a failed one.
 *
 * An embedder that breaks its own declared contract is not an outage but a defect
 * in the adapter (a 500 `ForemanError` such as `embedding_dims_mismatch`), and it
 * propagates. Degraded here, it would hide once per search, forever, behind a
 * warning line indistinguishable from the benign "nothing backfilled yet" case.
 */
export const embedQueriesOrDegrade = async (
  embedder: Embedder,
  queries: readonly string[],
): Promise<{ vectors: Float32Array[] } | { degraded: string }> => {
  try {
    return { vectors: await embedder.embed([...queries]) };
  } catch (error) {
    if (isForemanError(error) && error.statusCode >= 500) {
      throw error;
    }

    return { degraded: error instanceof Error ? error.message : String(error) };
  }
};
