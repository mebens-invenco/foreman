import type { Embedder } from "../embeddings/embedder.js";
import type { LearningRepo, LearningSearchRecord } from "../repos/learning-repo.js";

export type HybridLearningSearchFilters = {
  queries: string[];
  repos?: string[];
  limit?: number;
  offset?: number;
};

/**
 * Hybrid search with an FTS-only safety net.
 *
 * Embeddings are an enhancement to retrieval, never a dependency of it: a model
 * that will not download, an embedder that fails to init, and a scope nothing
 * has been backfilled into yet all degrade to the bm25 pipeline with a warning.
 * A degraded search must not become a failed search — the same discipline the
 * retrieval telemetry follows.
 *
 * The returned records carry whichever pipeline's `score` produced them (fused
 * descending for hybrid, raw bm25 ascending for the fallback), so callers must
 * not compare scores across a fallback boundary.
 */
export const searchLearningsWithHybridFallback = async (
  deps: { learnings: LearningRepo; embedder: Embedder; warn: (message: string) => void },
  filters: HybridLearningSearchFilters,
): Promise<LearningSearchRecord[]> => {
  const { learnings, embedder, warn } = deps;
  const options = { incrementReadCount: true };
  const fallBackToFts = (reason: string): LearningSearchRecord[] => {
    warn(`hybrid learning search unavailable, falling back to FTS: ${reason}`);
    return learnings.searchLearnings(filters, options);
  };

  // Checked before embedding: a scope with no vectors would reduce the fusion to
  // bm25-only, which is the fallback wearing a hybrid label. It also spares the
  // caller a model download that could not change the answer.
  const embeddingCount = learnings.countLearningEmbeddings({
    ...(filters.repos && filters.repos.length > 0 ? { repos: filters.repos } : {}),
    model: embedder.modelId,
  });
  if (embeddingCount === 0) {
    return fallBackToFts(`no ${embedder.modelId} learning embeddings in scope; run \`foreman learnings backfill-embeddings\``);
  }

  try {
    const vectors = await embedder.embed(filters.queries);
    return learnings.searchLearningsHybrid(filters, { model: embedder.modelId, vectors }, options);
  } catch (error) {
    // Narrow by construction: the embedder (model download, init, inference) and
    // the fusion's vector-width check are the only things in here that throw. A
    // repo-level fault would take the fallback's `searchLearnings` down with it.
    return fallBackToFts(error instanceof Error ? error.message : String(error));
  }
};
