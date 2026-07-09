import { ForemanError } from "../lib/errors.js";
import type { LearningRepo } from "../repos/learning-repo.js";
import type { Embedder } from "./embedder.js";
import { learningEmbeddingText } from "./learning-embedding-text.js";

const BATCH_SIZE = 32;

export type BackfillLearningEmbeddingsResult = {
  model: string;
  total: number;
  embedded: number;
  skipped: number;
};

/**
 * Embeds every learning whose vector is absent or stale for `embedder.modelId`.
 * Idempotent: a second consecutive run embeds nothing.
 */
export const backfillLearningEmbeddings = async (deps: {
  learnings: LearningRepo;
  embedder: Embedder;
}): Promise<BackfillLearningEmbeddingsResult> => {
  const { learnings, embedder } = deps;
  const total = learnings.listLearnings().length;
  const staleIds = learnings.listLearningIdsMissingEmbedding(embedder.modelId);

  let embedded = 0;
  for (let start = 0; start < staleIds.length; start += BATCH_SIZE) {
    const batch = learnings.getLearningsByIds(staleIds.slice(start, start + BATCH_SIZE));
    const vectors = await embedder.embed(batch.map(learningEmbeddingText));

    batch.forEach((learning, index) => {
      const vector = vectors[index];
      if (!vector) {
        throw new ForemanError(
          "embedding_count_mismatch",
          `Embedder returned ${vectors.length} vectors for ${batch.length} learnings`,
          500,
        );
      }

      // `learning` is the snapshot the vector was computed from. A concurrent
      // serve-loop write between the read and here means our vector is already
      // stale; the repo drops it and the row stays flagged for the next run.
      const applied = learnings.upsertLearningEmbedding({
        learningId: learning.id,
        model: embedder.modelId,
        dims: embedder.dims,
        vector,
        embeddedTitle: learning.title,
        embeddedContent: learning.content,
      });
      if (applied) {
        embedded += 1;
      }
    });
  }

  return { model: embedder.modelId, total, embedded, skipped: total - embedded };
};
