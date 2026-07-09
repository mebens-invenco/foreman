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
  getLearningsByIds(ids: string[], options?: LearningReadOptions): LearningRecord[];
  listLearnings(filters?: { search?: string; repo?: string; limit?: number; offset?: number }): LearningRecord[];
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
}
