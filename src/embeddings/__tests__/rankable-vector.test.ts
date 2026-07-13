import { describe, expect, test } from "vitest";

import { ForemanError } from "../../lib/errors.js";
import { assertRankableVector, isRankableVector } from "../rankable-vector.js";

const vector = (...values: number[]) => Float32Array.from(values);

describe("isRankableVector", () => {
  test("accepts any vector with a direction", () => {
    expect(isRankableVector(vector(1, 0, 0))).toBe(true);
    expect(isRankableVector(vector(-1, -1, -1))).toBe(true);
    // Unnormalized and tiny are both fine: the rule is about direction, not size.
    expect(isRankableVector(vector(1e-20, 0))).toBe(true);
    expect(isRankableVector(vector(3.4e38, 3.4e38))).toBe(true);
  });

  test("rejects a vector with no direction, or one that is not a number", () => {
    expect(isRankableVector(vector(0, 0, 0))).toBe(false);
    expect(isRankableVector(vector(NaN, 1))).toBe(false);
    expect(isRankableVector(vector(Infinity, 1))).toBe(false);
    expect(isRankableVector(vector(1, -Infinity))).toBe(false);
    // An empty vector has no magnitude either.
    expect(isRankableVector(vector())).toBe(false);
  });
});

describe("assertRankableVector", () => {
  test("names which of the two rules a vector broke", () => {
    expect(() => assertRankableVector(vector(NaN, 1))).toThrow(ForemanError);
    expect(() => assertRankableVector(vector(NaN, 1))).toThrow(/non-finite component/);
    expect(() => assertRankableVector(vector(Infinity, 1))).toThrow(/non-finite component/);
    expect(() => assertRankableVector(vector(0, 0))).toThrow(/no direction/);
  });

  test("raises a 500: an unrankable vector is a defect in whatever produced it", () => {
    // Not a 4xx. Nobody asks for a zero vector — a caller reaching here means an
    // embedder or a writer broke its own contract, and it must not degrade quietly.
    try {
      assertRankableVector(vector(0, 0));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ForemanError);
      expect((error as ForemanError).statusCode).toBe(500);
      expect((error as ForemanError).code).toBe("embedding_vector_zero_magnitude");
    }
  });

  test("passes a vector that can be ranked", () => {
    expect(() => assertRankableVector(vector(0, 1, 0))).not.toThrow();
  });
});
