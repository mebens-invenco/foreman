import type { Embedder } from "../embeddings/embedder.js";
import { isForemanError } from "../lib/errors.js";
import type { LearningRepo, LearningSearchRecord } from "../repos/learning-repo.js";
import type { RetrievalPipeline } from "./retrieval-pipeline.js";

export type HybridLearningSearchFilters = {
  queries: string[];
  repos?: string[];
  limit?: number;
  offset?: number;
};

export type HybridLearningSearchResult = {
  pipeline: RetrievalPipeline;
  learnings: LearningSearchRecord[];
};

/**
 * Below this fraction of the in-scope corpus carrying a current vector, the
 * cosine arm sees too little of the corpus to rank it fairly: an embedded but
 * irrelevant learning collects fusion weight that an unembedded, relevant one
 * can never earn, so hybrid can rank BELOW the FTS baseline. Presence of any
 * vector is not enough — coverage is what makes the two arms comparable.
 */
export const MIN_EMBEDDING_COVERAGE = 0.9;

/**
 * Hybrid search with an FTS-only safety net.
 *
 * Embeddings are an enhancement to retrieval, never a dependency of it: a model
 * that will not download, an embedder that fails to init or infer, and a scope
 * that is not yet backfilled all degrade to the bm25 pipeline with a warning.
 * A degraded search must not become a failed search — the same discipline the
 * retrieval telemetry follows.
 *
 * Everything else propagates. A defect is not a degrade: a corrupt vector blob,
 * a fault on `learning_embedding`, or an `Embedder` that breaks its own contract
 * would otherwise be swallowed once per search, forever, behind a warning line
 * indistinguishable from the benign "nothing backfilled yet" case. Note that
 * `searchLearnings` never reads `learning_embedding`, so such a fault would not
 * take the fallback down with it — it would simply go unnoticed.
 *
 * `score` flips meaning across the fallback boundary (fused descending for
 * hybrid, raw bm25 ascending for FTS), which is why the pipeline that answered
 * is returned rather than left for the caller to guess.
 */
export const searchLearningsWithHybridFallback = async (
  deps: { learnings: LearningRepo; embedder: Embedder; warn: (message: string) => void },
  filters: HybridLearningSearchFilters,
): Promise<HybridLearningSearchResult> => {
  const { learnings, embedder, warn } = deps;
  const options = { incrementReadCount: true };
  const scope = filters.repos && filters.repos.length > 0 ? { repos: filters.repos } : {};
  const fallBackToFts = (reason: string): HybridLearningSearchResult => {
    warn(`hybrid learning search unavailable, falling back to FTS: ${reason}`);
    return { pipeline: "fts", learnings: learnings.searchLearnings(filters, options) };
  };

  // Checked before embedding, so the fallback never pays for a model download
  // that could not have changed the answer.
  const learningCount = learnings.countLearnings(scope);
  if (learningCount === 0) {
    return { pipeline: "fts", learnings: [] };
  }

  const embeddingCount = learnings.countLearningEmbeddings({ ...scope, model: embedder.modelId });
  const coverage = embeddingCount / learningCount;
  if (coverage < MIN_EMBEDDING_COVERAGE) {
    return fallBackToFts(
      `only ${embeddingCount}/${learningCount} in-scope learnings carry a ${embedder.modelId} vector ` +
        `(need ${Math.round(MIN_EMBEDDING_COVERAGE * 100)}%); run \`foreman learnings backfill-embeddings\``,
    );
  }

  let vectors: Float32Array[];
  try {
    vectors = await embedder.embed(filters.queries);
  } catch (error) {
    // An embedder that breaks its declared contract (a 500 ForemanError such as
    // `embedding_dims_mismatch`) is a defect in the adapter, not an outage.
    if (isForemanError(error) && error.statusCode >= 500) {
      throw error;
    }

    return fallBackToFts(error instanceof Error ? error.message : String(error));
  }

  return { pipeline: "hybrid", learnings: learnings.searchLearningsHybrid(filters, { model: embedder.modelId, vectors }, options) };
};
