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
  getLearningsByIds(ids: string[], options?: LearningReadOptions): LearningRecord[];
  listLearnings(filters?: { search?: string; repo?: string; limit?: number; offset?: number }): LearningRecord[];
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
}
