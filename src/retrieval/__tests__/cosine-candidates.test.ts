import { describe, expect, test } from "vitest";

import { COSINE_TOP_K, COSINE_Z_FLOOR, selectCosineCandidates } from "../cosine-candidates.js";

const embedding = (learningId: string, vector: number[]) => ({ learningId, vector: Float32Array.from(vector) });

/** `count` learnings pointing at [1,0,0], the direction a FLAT query matches. */
const crowd = (count: number, from = 0) =>
  Array.from({ length: count }, (_unused, index) => embedding(`crowd-${String(from + index).padStart(2, "0")}`, [1, 0, 0]));

const ALONG_Y = Float32Array.from([0, 1, 0]);
const ALONG_X = Float32Array.from([1, 0, 0]);

describe("selectCosineCandidates", () => {
  test("proposes only the learnings that stand out from the corpus", () => {
    // One outlier among ten: z = 3.0, comfortably over the floor. Everything
    // else sits below the mean. A total ranking would return all ten.
    const candidates = selectCosineCandidates(ALONG_Y, [embedding("outlier", [0, 1, 0]), ...crowd(9)]);

    expect(candidates).toEqual(["outlier"]);
  });

  test("proposes nothing when no learning stands out", () => {
    // The query points straight at the crowd, so the crowd is the mean.
    expect(selectCosineCandidates(ALONG_X, crowd(10))).toEqual([]);
  });

  test("stays silent on a corpus too small to have an outlier", () => {
    // The largest z attainable with n embeddings is (n - 1) / sqrt(n): 1.79 at
    // n = 5, 2.04 at n = 6. So a perfect match cannot clear the floor until the
    // corpus is big enough for "outlier" to mean anything.
    const perfectMatch = embedding("outlier", [0, 1, 0]);
    expect((5 - 1) / Math.sqrt(5)).toBeLessThan(COSINE_Z_FLOOR);
    expect((6 - 1) / Math.sqrt(6)).toBeGreaterThan(COSINE_Z_FLOOR);

    expect(selectCosineCandidates(ALONG_Y, [perfectMatch, ...crowd(4)])).toEqual([]);
    expect(selectCosineCandidates(ALONG_Y, [perfectMatch, ...crowd(5)])).toEqual(["outlier"]);
  });

  test("stays silent on a single embedding rather than pinning it to rank 1", () => {
    // Zero standard deviation: dividing by it would hand the only row an
    // infinite z and let it tie the top bm25 hit on every search.
    expect(selectCosineCandidates(ALONG_Y, [embedding("only", [0, 1, 0])])).toEqual([]);
    expect(selectCosineCandidates(ALONG_Y, [])).toEqual([]);
  });

  test("caps the candidate list at COSINE_TOP_K, keeping the most similar", () => {
    // 12 near-identical outliers over a large crowd, each slightly less similar
    // than the last. Only the best COSINE_TOP_K may reach the fusion.
    const outliers = Array.from({ length: 12 }, (_unused, index) =>
      embedding(`out-${String(index).padStart(2, "0")}`, [index * 0.001, 1, 0]),
    );
    const candidates = selectCosineCandidates(ALONG_Y, [...outliers, ...crowd(200)]);

    expect(candidates).toHaveLength(COSINE_TOP_K);
    expect(candidates[0]).toBe("out-00");
    expect(candidates).not.toContain("out-11");
  });

  test("orders candidates by descending similarity, breaking ties on id", () => {
    const candidates = selectCosineCandidates(ALONG_Y, [
      embedding("b-tied", [0, 1, 0]),
      embedding("a-tied", [0, 1, 0]),
      embedding("c-lower", [0.4, 1, 0]),
      ...crowd(20),
    ]);

    expect(candidates).toEqual(["a-tied", "b-tied", "c-lower"]);
  });
});
