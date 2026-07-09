/**
 * Which retriever answered a learnings search.
 *
 * Lives on its own because both the retrieval layer and the telemetry that
 * persists it need the name, and neither should depend on the other.
 *
 * A record's `score` is only meaningful next to its pipeline: `hybrid` reports a
 * fused RRF score where higher is better, `fts` reports raw bm25 where more
 * negative is better. Scores must never be compared across the two.
 */
export type RetrievalPipeline = "hybrid" | "fts";
