import { ForemanError } from "../lib/errors.js";

/**
 * Whether a vector can take part in a cosine ranking: every component finite, and
 * a magnitude to divide by.
 *
 * A vector that fails this is not a bad match — it is meaningless, and it poisons
 * everything computed from it:
 *
 * - A NaN or Infinity component makes the corpus mean and standard deviation NaN,
 *   and every comparison against the z floor is then false. One such vector
 *   silently empties the entire cosine arm while the search still answers.
 * - A zero-magnitude vector has no direction. Scoring it 0 puts it at the HEAD of
 *   a ranking whose similarities are negative, not out of it.
 *
 * The rule lives here rather than in the cosine code because the read end is the
 * wrong place to learn about it. Every boundary a vector crosses — the embedder
 * port that produces it, the repo that persists it, the similarity that scores it
 * — enforces this one predicate.
 */
export const isRankableVector = (vector: Float32Array): boolean => {
  const total = sumOfSquares(vector);
  return Number.isFinite(total) && total > 0;
};

export const assertRankableVector = (vector: Float32Array): void => {
  const total = sumOfSquares(vector);

  if (!Number.isFinite(total)) {
    throw new ForemanError(
      "embedding_vector_not_finite",
      `Cannot rank a ${vector.length}-dim vector with a non-finite component`,
      500,
    );
  }

  if (total === 0) {
    throw new ForemanError(
      "embedding_vector_zero_magnitude",
      `Cannot rank a ${vector.length}-dim vector of zero magnitude: it has no direction`,
      500,
    );
  }
};

// A non-finite component makes its own square non-finite, so this catches NaN and
// +/-Infinity alike without a second pass. Float32 components cannot overflow a
// float64 accumulator, so a finite vector never looks non-finite here.
const sumOfSquares = (vector: Float32Array): number => {
  let total = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index]!;
    total += value * value;
  }

  return total;
};
