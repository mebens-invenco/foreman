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
 * Either the hybrid ranking, or the coverage that was too thin to authorize it.
 * The two are exclusive by construction: the caller cannot receive a ranking that
 * the gate did not clear, nor a shortfall it can ignore.
 */
export type CoveredHybridSearch =
  | { covered: true; learnings: LearningSearchRecord[] }
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
  getLearningsByIds(ids: string[], options?: LearningReadOptions): LearningRecord[];
  listLearnings(filters?: { search?: string; repo?: string; limit?: number; offset?: number }): LearningRecord[];
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
