export type LearningRecord = {
  id: string;
  title: string;
  repo: string;
  tags: string[];
  confidence: "emerging" | "established" | "proven";
  content: string;
  appliedCount: number;
  readCount: number;
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

export interface LearningRepo {
  addLearning(input: {
    id?: string;
    title: string;
    repo: string;
    confidence: "emerging" | "established" | "proven";
    content: string;
    tags: string[];
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
  getLearningsByIds(ids: string[], options?: LearningReadOptions): LearningRecord[];
  listLearnings(filters?: { search?: string; repo?: string; limit?: number; offset?: number }): LearningRecord[];
  /** How many learnings the given repo scope holds, embedded or not. */
  countLearnings(filters?: { repos?: string[] }): number;
  /**
   * Writes the vector only while the learning's embedded text still matches
   * `embeddedTitle`/`embeddedContent`. Returns false when it no longer does —
   * a slower writer must not overwrite a newer vector and stamp it current,
   * which would hide the row from `listLearningIdsMissingEmbedding` forever.
   */
  upsertLearningEmbedding(input: LearningEmbeddingUpsert): boolean;
  /** Learnings with no vector, a vector from another model, or a vector older than the learning. */
  listLearningIdsMissingEmbedding(model: string): string[];
  /**
   * The table holds one vector per learning but spans model generations until a
   * backfill completes. Pass `model` to read a single, comparable vector space;
   * omitting it returns every generation, whose vectors differ in width and
   * meaning and must not be compared to one another.
   */
  getLearningEmbeddings(filters?: { repos?: string[]; model?: string }): LearningEmbeddingRecord[];
  /**
   * The vectors `listLearningIdsMissingEmbedding` would NOT flag: present, from
   * `model`, and no older than the learning they describe. Anything that reasons
   * about whether a scope is usably embedded must read this rather than
   * `getLearningEmbeddings`, or it will count vectors describing text that has
   * since changed.
   */
  getCurrentLearningEmbeddings(filters: { repos?: string[]; model: string }): LearningEmbeddingRecord[];
  /** Same rows as `getCurrentLearningEmbeddings`, without decoding any vector. */
  countCurrentLearningEmbeddings(filters: { repos?: string[]; model: string }): number;
}
