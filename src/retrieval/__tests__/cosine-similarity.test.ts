import { describe, expect, test } from "vitest";

import { ForemanError } from "../../lib/errors.js";
import { selectCosineCandidates } from "../cosine-candidates.js";
import { cosineSimilarity } from "../cosine-similarity.js";

describe("cosineSimilarity", () => {
  test("returns 1 for identical directions, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1, 6);
  });

  test("measures direction, not magnitude, so unnormalized vectors still score 1", () => {
    // The `Embedder` port promises a width, never a magnitude — FakeEmbedder's
    // vectors are unnormalized, so a dot-product-only implementation would score
    // these 30 instead of 1.
    expect(cosineSimilarity(Float32Array.from([3, 4]), Float32Array.from([6, 8]))).toBeCloseTo(1, 6);
  });

  test("refuses a vector with a non-finite component, on either side", () => {
    // A NaN similarity poisons the corpus mean and standard deviation, and every
    // `>= COSINE_Z_FLOOR` comparison against NaN is false — so one bad vector
    // silently empties the whole cosine arm while the search still calls itself
    // hybrid. It has to be loud.
    const healthy = Float32Array.from([1, 0]);
    for (const rogue of [Float32Array.from([NaN, 0]), Float32Array.from([Infinity, 0]), Float32Array.from([0, -Infinity])]) {
      expect(() => cosineSimilarity(healthy, rogue)).toThrow(ForemanError);
      expect(() => cosineSimilarity(healthy, rogue)).toThrow(/non-finite component/);
      expect(() => cosineSimilarity(rogue, healthy)).toThrow(/non-finite component/);
    }
  });

  test("refuses a zero-magnitude vector rather than scoring it 0", () => {
    const zero = Float32Array.from([0, 0]);
    expect(() => cosineSimilarity(Float32Array.from([1, 1]), zero)).toThrow(ForemanError);
    expect(() => cosineSimilarity(Float32Array.from([1, 1]), zero)).toThrow(/no direction/);
    expect(() => cosineSimilarity(zero, zero)).toThrow(/no direction/);
  });

  test("refuses to compare vectors of different widths", () => {
    expect(() => cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toThrow(ForemanError);
    expect(() => cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toThrow(/2-dim vector with a 3-dim vector/);
  });

  test("keeps a directionless vector from becoming the top cosine candidate", () => {
    // Scoring a zero vector 0 does NOT keep it out of the ranking's head, which is
    // what this code used to claim. Against five similarities of -1 its 0 is the
    // maximum: z = 2.04, over the floor, and a vector with no direction comes back
    // as the single best match. Refusing it at the source is what stops that.
    const query = Float32Array.from([0, 1, 0]);
    const opposite = [0, -1, 0];
    const corpus = [
      { learningId: "zero", vector: Float32Array.from([0, 0, 0]) },
      ...Array.from({ length: 5 }, (_unused, index) => ({ learningId: `neg-${index}`, vector: Float32Array.from(opposite) })),
    ];

    expect(() => selectCosineCandidates(query, corpus)).toThrow(/no direction/);
  });
});
