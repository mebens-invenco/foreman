import type { Embedder } from "../embeddings/embedder.js";
import { ForemanError } from "../lib/errors.js";
import type { LearningRepo, SimilarLearning } from "../repos/learning-repo.js";
import { embedQueriesOrDegrade, embeddingShortfall, MIN_EMBEDDING_COVERAGE } from "./embedding-coverage-gate.js";

export type SimilarLearningSearchFilters = {
  query: string;
  repos?: string[];
  /** A cap on the list, never a quota to fill. */
  limit: number;
  /** The absolute cosine bar a learning must clear. The caller's, because the caller's question decides it. */
  minSimilarity: number;
};

/**
 * The in-scope learnings close enough to the query to be worth pushing at a caller
 * who never asked for them, closest first — and nothing at all when that cannot be
 * decided honestly.
 *
 * The counterpart to `searchLearningsWithHybridFallback`, and deliberately not a
 * mode of it. Both gate on the same embedding coverage, degrade on the same
 * embedder failures and propagate the same adapter defects; they part on what a
 * missing vector space means. A search still has an answer without one — bm25 —
 * and falls back to it. A PUSH does not: a learning matched by text alone carries
 * no evidence of closeness, and "no evidence it is close" is not evidence that it
 * is. So every degrade here returns nothing rather than something worse, and the
 * empty list is load-bearing.
 *
 * Nothing here is fused or ranked against bm25. On this path the bm25 arm was
 * always nearly silent — one long query (a whole title + description) that FTS ANDs
 * every term of, matching in 1 of 54 bench cases — and whatever it did match was
 * floored out again for carrying no similarity. Dropping it costs no reachable
 * learning and buys back the fusion window it was occupying.
 */
export const selectSimilarLearnings = async (
  deps: { learnings: LearningRepo; embedder: Embedder; warn: (message: string) => void },
  filters: SimilarLearningSearchFilters,
): Promise<SimilarLearning[]> => {
  const { learnings, embedder, warn } = deps;
  const skip = (reason: string): SimilarLearning[] => {
    warn(`relevant-learnings injection skipped: ${reason}`);
    return [];
  };

  const query = filters.query.trim();
  if (query.length === 0) {
    return [];
  }

  const repos = filters.repos ?? [];
  const scope = repos.length > 0 ? { repos } : {};

  // An empty store is not a degrade, and must not put a warning line in the log of
  // every attempt in a workspace that has simply not learned anything yet.
  const learningCount = learnings.countLearnings(scope);
  if (learningCount === 0) {
    return [];
  }

  // An optimization, not the gate: it spares the caller a model download (133MB on
  // a cold cache) that could not have changed the answer. The decision that really
  // authorizes reading the geometry is made below, inside the snapshot that reads it.
  const embeddingCount = learnings.countCurrentLearningEmbeddings({ ...scope, model: embedder.modelId });
  if (embeddingCount / learningCount < MIN_EMBEDDING_COVERAGE) {
    return skip(embeddingShortfall(embedder, { embeddingCount, learningCount }));
  }

  const embedded = await embedQueriesOrDegrade(embedder, [query]);
  if ("degraded" in embedded) {
    return skip(embedded.degraded);
  }

  const [vector] = embedded.vectors;
  if (!vector) {
    throw new ForemanError("embedding_query_vector_missing", `${embedder.modelId} returned no vector for the injection query`, 500);
  }

  const result = learnings.selectSimilarLearningsCovered(
    { repos, limit: filters.limit },
    { model: embedder.modelId, vector },
    { minCoverage: MIN_EMBEDDING_COVERAGE, minSimilarity: filters.minSimilarity },
  );
  if (result.covered) {
    return result.learnings;
  }

  // The store can empty while the model initializes and infers, and a corpus with
  // nothing in it is still not a degrade — `only 0/0 learnings carry a vector` is
  // not a line anyone can act on.
  return result.learningCount === 0 ? [] : skip(embeddingShortfall(embedder, result));
};
