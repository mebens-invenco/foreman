/**
 * The canonical text embedded for a learning. Every producer (write path,
 * backfill) must use this so vectors stay comparable across code paths.
 */
export const learningEmbeddingText = (learning: { title: string; content: string }): string =>
  `${learning.title}\n${learning.content}`;
