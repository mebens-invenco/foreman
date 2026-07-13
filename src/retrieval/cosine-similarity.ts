import { ForemanError } from "../lib/errors.js";

/**
 * Cosine similarity of two vectors, in [-1, 1].
 *
 * The `Embedder` port promises a width, not a magnitude, so the norms are
 * computed rather than assumed to be 1 — bge-small happens to return
 * L2-normalized vectors, but `FakeEmbedder` does not.
 *
 * A vector that cannot have a direction — a non-finite component, or zero
 * magnitude — is a defect in whatever produced or stored it, and is refused
 * rather than scored. Neither has a safe value to return:
 *
 * - A NaN or Infinity component poisons the similarity, and from there the
 *   corpus mean and standard deviation. Every `>= COSINE_Z_FLOOR` comparison
 *   against NaN is false, so ONE bad vector silently empties the entire cosine
 *   arm while the search still answers, and still calls itself hybrid.
 * - Scoring a zero-magnitude vector 0 does not keep it out of the ranking's
 *   head, which is what this code used to claim. Against a corpus of negative
 *   similarities its 0 is the maximum: five vectors at -1 put it at z = 2.04,
 *   over the floor, and a vector with no direction is returned as the single
 *   best match.
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

  // A non-finite component makes its own sum of squares non-finite, so the sums
  // catch NaN and +/-Infinity alike. Float32 components cannot overflow these
  // float64 accumulators, so a finite vector never trips this.
  assertRankable(leftSumOfSquares, left);
  assertRankable(rightSumOfSquares, right);

  return dotProduct / (Math.sqrt(leftSumOfSquares) * Math.sqrt(rightSumOfSquares));
};

const assertRankable = (sumOfSquares: number, vector: Float32Array): void => {
  if (!Number.isFinite(sumOfSquares)) {
    throw new ForemanError(
      "embedding_vector_not_finite",
      `Cannot rank a ${vector.length}-dim vector with a non-finite component`,
      500,
    );
  }

  if (sumOfSquares === 0) {
    throw new ForemanError(
      "embedding_vector_zero_magnitude",
      `Cannot rank a ${vector.length}-dim vector of zero magnitude: it has no direction`,
      500,
    );
  }
};
