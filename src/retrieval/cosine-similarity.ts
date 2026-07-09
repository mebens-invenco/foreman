import { ForemanError } from "../lib/errors.js";

/**
 * Cosine similarity of two vectors, in [-1, 1].
 *
 * The `Embedder` port promises a width, not a magnitude, so the norms are
 * computed rather than assumed to be 1 — bge-small happens to return
 * L2-normalized vectors, but `FakeEmbedder` does not.
 *
 * A zero-magnitude vector has no direction, so its similarity is undefined.
 * Returning 0 rather than NaN keeps such a vector out of a ranking's head
 * instead of making the surrounding sort order implementation-defined.
 */
export const cosineSimilarity = (left: Float32Array, right: Float32Array): number => {
  if (left.length !== right.length) {
    throw new ForemanError(
      "embedding_dims_mismatch",
      `Cannot compare a ${left.length}-dim vector with a ${right.length}-dim vector`,
      500,
    );
  }

  let dotProduct = 0;
  let leftSumOfSquares = 0;
  let rightSumOfSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dotProduct += leftValue * rightValue;
    leftSumOfSquares += leftValue * leftValue;
    rightSumOfSquares += rightValue * rightValue;
  }

  const magnitude = Math.sqrt(leftSumOfSquares) * Math.sqrt(rightSumOfSquares);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
};
