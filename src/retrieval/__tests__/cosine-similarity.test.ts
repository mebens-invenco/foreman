import { describe, expect, test } from "vitest";

import { ForemanError } from "../../lib/errors.js";
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

  test("scores a zero-magnitude vector 0 rather than NaN", () => {
    // A zero vector has no direction. NaN here would make every comparison in a
    // ranking sort false and leave the result order implementation-defined.
    const similarity = cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]));

    expect(similarity).toBe(0);
    expect(Number.isNaN(similarity)).toBe(false);
  });

  test("refuses to compare vectors of different widths", () => {
    expect(() => cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toThrow(ForemanError);
    expect(() => cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toThrow(/2-dim vector with a 3-dim vector/);
  });
});
