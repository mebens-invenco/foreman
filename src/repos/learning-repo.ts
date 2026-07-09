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
   * `queryEmbedding.vectors[i]` must embed `filters.queries[i]` — same length,
   * same order. `queryEmbedding.model` selects the comparable vector space (see
   * `getLearningEmbeddings`), so it must be the model that produced `vectors`.
   *
   * `score` on the returned records is the fused score, where HIGHER is better —
   * the opposite of the raw bm25 `score` from `searchLearnings`. The two are not
   * comparable to one another.
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
  upsertLearningEmbedding(input: LearningEmbeddingRecord): void;
  /** Learnings with no vector, a vector from another model, or a vector older than the learning. */
  listLearningIdsMissingEmbedding(model: string): string[];
  /**
   * The table holds one vector per learning but spans model generations until a
   * backfill completes. Pass `model` to read a single, comparable vector space;
   * omitting it returns every generation, whose vectors differ in width and
   * meaning and must not be compared to one another.
   */
  getLearningEmbeddings(filters?: { repos?: string[]; model?: string }): LearningEmbeddingRecord[];
  /** Same filters as `getLearningEmbeddings`, without decoding any vector. */
  countLearningEmbeddings(filters?: { repos?: string[]; model?: string }): number;
}
