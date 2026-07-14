import type { Embedder } from "../embeddings/embedder.js";
import type { LearningReadOptions, LearningRepo, LearningRetrievalProvenance, LearningSearchRecord } from "../repos/learning-repo.js";
import { embedQueriesOrDegrade, embeddingShortfall, MIN_EMBEDDING_COVERAGE } from "./embedding-coverage-gate.js";

export type HybridLearningSearchFilters = {
  queries: string[];
  repos?: string[];
  limit?: number;
  offset?: number;
};

/**
 * Discriminated on the pipeline that answered, because what a result carries
 * differs across the fallback boundary rather than merely being labelled by it:
 * `score` inverts (fused descending vs raw bm25 ascending), and arm provenance
 * exists only where there were two arms to attribute a hit to. A caller that
 * needs provenance — a relevance floor — therefore cannot be served by the
 * fallback at all, and the type says so instead of handing back an empty map.
 */
export type HybridLearningSearchResult =
  | { pipeline: "hybrid"; learnings: LearningSearchRecord[]; provenance: ReadonlyMap<string, LearningRetrievalProvenance> }
  | { pipeline: "fts"; learnings: LearningSearchRecord[] };

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
  // Defaults to counting the read, because every caller that asks a question on
  // an agent's behalf is a read. Push injection is the exception that proves it:
  // nobody asked, so counting it would make the "did the agent consult a
  // learning" metric true by construction.
  options: LearningReadOptions = { incrementReadCount: true },
): Promise<HybridLearningSearchResult> => {
  const { learnings, embedder, warn } = deps;
  const scope = filters.repos && filters.repos.length > 0 ? { repos: filters.repos } : {};
  const fallBackToFts = (reason: string): HybridLearningSearchResult => {
    warn(`hybrid learning search unavailable, falling back to FTS: ${reason}`);
    return { pipeline: "fts", learnings: learnings.searchLearnings(filters, options) };
  };

  // A query that trims to nothing reaches neither arm, and `searchLearningsHybrid`
  // refuses it. Answer from FTS — whose no-query branch is a recency listing —
  // and label it honestly, rather than embedding a blank string (in production,
  // a 133MB model download) to fuse nothing.
  if (!filters.queries.some((query) => query.trim().length > 0)) {
    return { pipeline: "fts", learnings: learnings.searchLearnings(filters, options) };
  }

  const shortfall = (embeddingCount: number, learningCount: number): string =>
    embeddingShortfall(embedder, { embeddingCount, learningCount });

  const learningCount = learnings.countLearnings(scope);
  if (learningCount === 0) {
    return { pipeline: "fts", learnings: [] };
  }

  // An optimization, not the gate: it spares the caller a model download that
  // could not have changed the answer. The decision that actually authorizes a
  // hybrid ranking is made below, after the wait, against the corpus the ranking
  // will really read.
  //
  // `countCurrent…`, not a bare presence count: a vector whose learning has been
  // edited since is one `backfill-embeddings` still owes, and the cosine arm
  // cannot see it. Counting it would hold the gate open over a corpus hybrid has
  // largely gone blind to.
  const embeddingCount = learnings.countCurrentLearningEmbeddings({ ...scope, model: embedder.modelId });
  if (embeddingCount / learningCount < MIN_EMBEDDING_COVERAGE) {
    return fallBackToFts(shortfall(embeddingCount, learningCount));
  }

  const embedded = await embedQueriesOrDegrade(embedder, filters.queries);
  if ("degraded" in embedded) {
    return fallBackToFts(embedded.degraded);
  }

  const { vectors } = embedded;

  // The corpus is free to move while the model initializes and infers — on a cold
  // cache that await is a 133MB download, and the serve loop writes learnings
  // throughout. So the gate is re-evaluated here, inside the same snapshot the
  // ranking reads, and a decision can never outlive the corpus it was made on.
  const result = learnings.searchLearningsHybridCovered(
    filters,
    { model: embedder.modelId, vectors },
    { minCoverage: MIN_EMBEDDING_COVERAGE },
    options,
  );
  if (!result.covered) {
    return result.learningCount === 0
      ? { pipeline: "fts", learnings: [] }
      : fallBackToFts(shortfall(result.embeddingCount, result.learningCount));
  }

  return { pipeline: "hybrid", learnings: result.learnings, provenance: result.provenance };
};
