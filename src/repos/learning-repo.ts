export type LearningRecord = {
  id: string;
  title: string;
  repo: string;
  tags: string[];
  confidence: "emerging" | "established" | "proven";
  content: string;
  appliedCount: number;
  readCount: number;
  /** Nearest in-scope learning at write time, when the two were near-identical. */
  duplicateOf: string | null;
  /** Task whose attempt produced this learning. Null for rows written before provenance existed. */
  sourceTaskId: string | null;
  /**
   * When the learning was soft-archived, or null while it is active. An archived
   * learning is excluded from every retrieval and injection surface but stays in
   * the store — resolvable by id, visible in the UI, and reversible.
   */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LearningSearchRecord = {
  id: string;
  title: string;
  repo: string;
  tags: string[];
  confidence: "emerging" | "established" | "proven";
  createdAt: string;
  updatedAt: string;
  score: number;
};

export type LearningReadOptions = {
  incrementReadCount?: boolean;
};

export type LearningEmbeddingRecord = {
  learningId: string;
  model: string;
  dims: number;
  vector: Float32Array;
};

export type LearningEmbeddingUpsert = LearningEmbeddingRecord & {
  /**
   * The title and content the vector was computed from. Embedding is async, so
   * the learning can change while a vector is in flight; the write is applied
   * only while the stored text still matches these.
   */
  embeddedTitle: string;
  embeddedContent: string;
};

/**
 * How strongly the cosine arm vouched for a hybrid hit.
 *
 * The fused score cannot answer that: it is built from ranks, so it reports how
 * the two arms agreed, never how close the hit actually is. A caller deciding
 * whether a learning is worth PUSHING at an agent who never asked for it — where
 * a wrong one costs more than a missing one — needs a bar it can hold in absolute
 * terms, so the fusion reports the similarity it already computed rather than
 * making the caller re-derive a ranking it cannot see.
 */
export type LearningRetrievalProvenance = {
  /**
   * Best (highest) cosine similarity across queries, or null when the cosine arm
   * never proposed it — a hit reached by bm25 alone carries no similarity, and
   * "no evidence it is close" is not the same as "close".
   */
  bestCosineSimilarity: number | null;
};

/**
 * Either the hybrid ranking, or the coverage that was too thin to authorize it.
 * The two are exclusive by construction: the caller cannot receive a ranking that
 * the gate did not clear, nor a shortfall it can ignore.
 */
export type CoveredHybridSearch =
  | { covered: true; learnings: LearningSearchRecord[]; provenance: ReadonlyMap<string, LearningRetrievalProvenance> }
  | { covered: false; learningCount: number; embeddingCount: number };

/**
 * A learning close enough to the query to be worth pushing, and how close.
 *
 * The similarity travels WITH the learning rather than in a side map, because on
 * this path it is not provenance about a ranking — it is the reason the learning is
 * here at all, and every consumer (the floor that admitted it, the telemetry that
 * records what reached a prompt) needs the two together.
 */
export type SimilarLearning = { learning: LearningRecord; similarity: number };

/**
 * Either the learnings close enough to push, or the coverage that was too thin to
 * judge closeness at all — exclusive by construction, as `CoveredHybridSearch` is.
 *
 * `covered: true` with an empty list is a real answer, and a different one from a
 * shortfall: the corpus was readable and holds nothing close enough.
 */
export type CoveredSimilarLearnings =
  | { covered: true; learnings: SimilarLearning[] }
  | { covered: false; learningCount: number; embeddingCount: number };

export interface LearningRepo {
  addLearning(input: {
    id?: string;
    title: string;
    repo: string;
    confidence: "emerging" | "established" | "proven";
    content: string;
    tags: string[];
    sourceTaskId?: string;
    duplicateOf?: string;
  }): string;
  updateLearning(input: {
    id: string;
    title?: string;
    repo?: string;
    confidence?: "emerging" | "established" | "proven";
    content?: string;
    tags?: string[];
    markApplied?: boolean;
  }): void;
  /**
   * Soft-archive a learning: stamp `archived_at` so it drops out of every
   * retrieval and injection surface while staying in the store. Throws
   * `learning_not_found` when no such learning exists.
   */
  archiveLearning(id: string): void;
  /** Clear `archived_at`, restoring the learning to retrieval. Throws `learning_not_found`. */
  unarchiveLearning(id: string): void;
  /**
   * Point each loser at the survivor it duplicates and soft-archive it — the
   * consolidation scan's apply step, applied to the whole batch atomically. Each
   * loser gains its `duplicate_of` and an `archived_at` stamp, so it leaves every
   * retrieval surface while staying resolvable by id (its `duplicate_of` link
   * included, so the UI still renders it). Never a delete: the usage-event history
   * M5 promotion consumes FKs the loser id and must stay joinable.
   *
   * All-or-nothing: the whole batch runs in one transaction. A partial apply would
   * strand a transitive-chain loser — archive B out of a chain A~B~C where A and C
   * are only linked through B, and the re-scan no longer sees an A~C edge, so C is
   * left active, unflagged, and undetectable. Rolling back on any failure keeps the
   * re-scan re-forming the identical clusters instead. Throws `learning_not_found`
   * for an unknown id (rolling the batch back).
   */
  flagAndArchiveDuplicates(pairs: readonly { id: string; duplicateOf: string }[]): void;
  searchLearnings(
    filters?: { queries?: string[]; repos?: string[]; limit?: number; offset?: number },
    options?: LearningReadOptions,
  ): LearningSearchRecord[];
  /**
   * Hybrid retrieval: per query, an FTS bm25 candidate list and a cosine ranking
   * of the in-scope corpus, fused with reciprocal rank fusion; the per-query
   * fused scores are then merged across queries by taking each learning's best,
   * as `searchLearnings` merges its bm25 scores.
   *
   * Only vectors that are current for `queryEmbedding.model` are ranked, so a
   * learning whose text moved on since it was embedded is reachable by bm25 but
   * never by cosine.
   *
   * `queryEmbedding.vectors[i]` must embed `filters.queries[i]` — same length,
   * same order. `queryEmbedding.model` selects the comparable vector space (see
   * `getLearningEmbeddings`), so it must be the model that produced `vectors`.
   *
   * `score` on the returned records is the fused score, where HIGHER is better —
   * the opposite of the raw bm25 `score` from `searchLearnings`. The two are not
   * comparable to one another.
   *
   * Throws when no query survives trimming: there is nothing to fuse, and the
   * caller must decide what an empty query means rather than receive a listing
   * wearing a hybrid label.
   */
  searchLearningsHybrid(
    filters: { queries?: string[]; repos?: string[]; limit?: number; offset?: number },
    queryEmbedding: { model: string; vectors: readonly Float32Array[] },
    options?: LearningReadOptions,
  ): LearningSearchRecord[];
  /**
   * `searchLearningsHybrid`, gated on embedding coverage — with the gate and the
   * ranking reading ONE database snapshot.
   *
   * Embedding a query is slow (on a cold cache, a model download), and the live
   * server writes to the same database throughout. A coverage check made before
   * that wait and enforced after it authorizes a ranking over a corpus that may
   * have moved underneath it, which is the biased ranking the gate exists to
   * prevent. So the check happens here, beside the read it guards, rather than in
   * the caller.
   */
  searchLearningsHybridCovered(
    filters: { queries?: string[]; repos?: string[]; limit?: number; offset?: number },
    queryEmbedding: { model: string; vectors: readonly Float32Array[] },
    gate: { minCoverage: number },
    options?: LearningReadOptions,
  ): CoveredHybridSearch;
  /**
   * The in-scope learnings sitting at or above `gate.minSimilarity` from the query,
   * closest first — gated on the same embedding coverage as
   * `searchLearningsHybridCovered`, and reading the same single snapshot for the
   * same reason.
   *
   * Cosine alone, floored on the similarity itself rather than on the corpus-relative
   * z the fusion ranks by. It answers "which learnings are close enough to push at an
   * agent who never asked", not "which learnings best answer this query", and the two
   * take different evidence: bm25 has no say here, because a text match carries no
   * evidence of closeness and this path has nothing to floor it on. z has no say
   * either — it is a bound on how far the dense arm may pad a fusion window, and this
   * path has no window to pad.
   *
   * `filters.limit` caps the list; it is not a quota, and a scope holding two
   * admissible learnings yields two. Required, because how many learnings may be
   * pushed at an agent unasked is the caller's question and has no sane default.
   *
   * Takes no `LearningReadOptions` and never counts a read: being handed a learning is
   * not consulting one, and a path that pushes learnings unasked would make the "did
   * the agent consult a learning" metric true by construction.
   */
  selectSimilarLearningsCovered(
    filters: { repos?: string[]; limit: number },
    queryEmbedding: { model: string; vector: Float32Array },
    gate: { minCoverage: number; minSimilarity: number },
  ): CoveredSimilarLearnings;
  /**
   * Resolve learnings by id, archived or not: an id in hand — a `learnings get`
   * after injection, a `duplicate_of` link — must keep resolving even once the
   * learning has been archived. Deliberately unfiltered.
   */
  getLearningsByIds(ids: string[], options?: LearningReadOptions): LearningRecord[];
  /**
   * `includeArchived` governs the browse path only: default false hides archived
   * rows (prompt-facing callers), true lists them (the UI/HTTP surface, where
   * archived rows are visible by design). The `search` path routes through
   * `searchLearnings` — a retrieval surface — and always hides archived
   * regardless, so a text query never surfaces an archived learning.
   */
  listLearnings(filters?: {
    search?: string;
    repo?: string;
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
  }): LearningRecord[];
  /** How many learnings the given repo scope holds, embedded or not. */
  countLearnings(filters?: { repos?: string[] }): number;
  /**
   * Writes the vector only while the learning's embedded text still matches
   * `embeddedTitle`/`embeddedContent`. Returns false when it no longer does —
   * a slower writer must not overwrite a newer vector and stamp it current,
   * which would hide the row from `listLearningIdsMissingEmbedding` forever.
   *
   * The matched text is snapshotted alongside the vector; it is what every
   * freshness check keys on.
   *
   * Throws rather than persist a vector nothing can rank, or one whose `dims`
   * disagree with its own width. This is the single choke point every vector
   * reaches the database through, so it is where such a row has to be stopped.
   */
  upsertLearningEmbedding(input: LearningEmbeddingUpsert): boolean;
  /**
   * The learnings `backfill-embeddings` owes a vector: the exact complement of
   * `getCurrentLearningEmbeddings`. No vector, a vector from another model, one
   * computed from text the learning no longer carries, or one nothing can rank.
   *
   * Metadata-only edits (tags, confidence, `applied_count`) leave a vector valid
   * and are NOT reported here.
   */
  listLearningIdsMissingEmbedding(model: string): string[];
  /**
   * The table holds one vector per learning but spans model generations until a
   * backfill completes. Pass `model` to read a single, comparable vector space;
   * omitting it returns every generation, whose vectors differ in width and
   * meaning and must not be compared to one another.
   */
  getLearningEmbeddings(filters?: { repos?: string[]; model?: string }): LearningEmbeddingRecord[];
  /**
   * The vectors that may actually be ranked: present, from `model`, computed from
   * the text the learning still carries, and rankable. Anything reasoning about
   * whether a scope is usably embedded must read this rather than
   * `getLearningEmbeddings`, or it will count vectors describing text that has
   * since changed — or vectors the fusion would refuse to use.
   */
  getCurrentLearningEmbeddings(filters: { repos?: string[]; model: string }): LearningEmbeddingRecord[];
  /** How many rows `getCurrentLearningEmbeddings` would return, and never a different set. */
  countCurrentLearningEmbeddings(filters: { repos?: string[]; model: string }): number;
  /**
   * Brute-force nearest neighbour of `vector` by cosine similarity, over the
   * CURRENT embeddings in `filters` scope (see `getCurrentLearningEmbeddings` —
   * a stale vector describes text the learning no longer carries, so a match
   * against it is not evidence of a duplicate). `undefined` when the scope
   * holds no current vectors.
   *
   * `model` is required, not optional: the table spans model generations, and a
   * neighbour from another generation is a meaningless comparison rather than a
   * distant one. Nothing is excluded within the scope — a near duplicate of an
   * already-flagged duplicate still resolves to its own nearest neighbour.
   */
  nearestLearningEmbedding(
    vector: Float32Array,
    filters: { model: string; repos?: string[] },
  ): { learningId: string; similarity: number } | undefined;
}
