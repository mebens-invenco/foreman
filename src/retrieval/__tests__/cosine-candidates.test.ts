import { describe, expect, test } from "vitest";

import { COSINE_TOP_K, COSINE_Z_FLOOR, selectCosineCandidates } from "../cosine-candidates.js";

const embedding = (learningId: string, vector: number[]) => ({ learningId, vector: Float32Array.from(vector) });

/** `count` learnings pointing at [1,0,0], the direction a FLAT query matches. */
const crowd = (count: number, from = 0) =>
  Array.from({ length: count }, (_unused, index) => embedding(`crowd-${String(from + index).padStart(2, "0")}`, [1, 0, 0]));

const ALONG_Y = Float32Array.from([0, 1, 0]);
const ALONG_X = Float32Array.from([1, 0, 0]);

/** The arm reports each candidate's similarity alongside its id; most assertions here are about which. */
const candidateIds = (...args: Parameters<typeof selectCosineCandidates>): string[] =>
  selectCosineCandidates(...args).map((candidate) => candidate.id);

describe("selectCosineCandidates", () => {
  test("proposes only the learnings that stand out from the corpus", () => {
    // One outlier among ten: z = 3.0, comfortably over the floor. Everything
    // else sits below the mean. A total ranking would return all ten.
    const candidates = selectCosineCandidates(ALONG_Y, [embedding("outlier", [0, 1, 0]), ...crowd(9)]);

    expect(candidates.map((candidate) => candidate.id)).toEqual(["outlier"]);
  });

  test("proposes nothing when no learning stands out", () => {
    // The query points straight at the crowd, so the crowd is the mean.
    expect(selectCosineCandidates(ALONG_X, crowd(10))).toEqual([]);
  });

  test("stays silent on a corpus too small to have an outlier", () => {
    // The largest z attainable with n embeddings is (n - 1) / sqrt(n) — the
    // SAMPLE standard deviation's bound, which is why the variance divides by
    // n - 1. So a perfect match cannot clear the floor until the corpus is big
    // enough for "outlier" to mean anything.
    const perfectMatch = embedding("outlier", [0, 1, 0]);
    const maxZ = (n: number) => (n - 1) / Math.sqrt(n);

    // The margins matter as much as the direction: a population variance (divide
    // by n) would bound z at sqrt(n - 1), putting n = 5 at exactly 2.0 — flush
    // against a `>=` floor, where firing comes down to floating-point rounding.
    expect(maxZ(5)).toBeCloseTo(1.789, 3);
    expect(maxZ(6)).toBeCloseTo(2.041, 3);
    expect(Math.sqrt(5 - 1)).toBe(COSINE_Z_FLOOR);

    expect(selectCosineCandidates(ALONG_Y, [perfectMatch, ...crowd(4)])).toEqual([]);
    expect(candidateIds(ALONG_Y, [perfectMatch, ...crowd(5)])).toEqual(["outlier"]);
  });

  test("rejects a candidate that only a population standard deviation would admit", () => {
    // Sample SD is the larger of the two, so sample z is the smaller: the arm is
    // strictly more conservative than a population variance would make it. These
    // six similarities (1.00, 0.66, 0.58, 0.57, 0.57, 0.45) put the leader at
    // z = 1.909 by sample SD and z = 2.091 by population SD — one side of the
    // floor each, with ~0.09 of margin, so this discriminates the two formulas
    // rather than resting on the n = 5 knife-edge.
    const xFor = (similarity: number) => Math.sqrt(1 / similarity ** 2 - 1);
    const corpus = [1, 0.57, 0.45, 0.66, 0.58, 0.57].map((similarity, index) =>
      embedding(index === 0 ? "outlier" : `crowd-${index}`, [similarity === 1 ? 0 : xFor(similarity), 1, 0]),
    );

    expect(selectCosineCandidates(ALONG_Y, corpus)).toEqual([]);
  });

  test("computes z against the sample standard deviation, not the population's", () => {
    // One outlier at similarity 1 among four at 0: mean 0.2, sample SD 0.4472,
    // so z = 1.789 and the arm stays silent. Under a population SD (0.4) the
    // same corpus yields z = 2.0 exactly, and the arm fires.
    const scored = [1, 0, 0, 0, 0];
    const mean = scored.reduce((total, value) => total + value, 0) / scored.length;
    const sumOfSquares = scored.reduce((total, value) => total + (value - mean) ** 2, 0);
    const sampleZ = (1 - mean) / Math.sqrt(sumOfSquares / (scored.length - 1));
    const populationZ = (1 - mean) / Math.sqrt(sumOfSquares / scored.length);

    expect(sampleZ).toBeCloseTo(1.789, 3);
    expect(sampleZ).toBeLessThan(COSINE_Z_FLOOR);

    // In exact arithmetic the population z here is 2.0 — sitting on the `>=`
    // floor. In doubles it lands a hair under, so a population variance would
    // have made the arm's silence at n = 5 an accident of rounding, not a rule.
    expect(Math.sqrt(scored.length - 1)).toBe(COSINE_Z_FLOOR);
    expect(populationZ).toBeLessThan(COSINE_Z_FLOOR);
    expect(COSINE_Z_FLOOR - populationZ).toBeLessThan(1e-15);

    expect(selectCosineCandidates(ALONG_Y, [embedding("outlier", [0, 1, 0]), ...crowd(4)])).toEqual([]);
  });

  test("stays silent on a single embedding rather than pinning it to rank 1", () => {
    // One row has no spread to be an outlier against, and the sample variance
    // would divide by zero. Two identical rows have zero spread, and dividing by
    // it would hand both an infinite z and let them tie the top bm25 hit.
    expect(selectCosineCandidates(ALONG_Y, [embedding("only", [0, 1, 0])])).toEqual([]);
    expect(selectCosineCandidates(ALONG_Y, [embedding("a", [0, 1, 0]), embedding("b", [0, 1, 0])])).toEqual([]);
    expect(selectCosineCandidates(ALONG_Y, [])).toEqual([]);
  });

  test("caps the candidate list at COSINE_TOP_K, keeping the most similar", () => {
    // 12 near-identical outliers over a large crowd, each slightly less similar
    // than the last. Only the best COSINE_TOP_K may reach the fusion.
    const outliers = Array.from({ length: 12 }, (_unused, index) =>
      embedding(`out-${String(index).padStart(2, "0")}`, [index * 0.001, 1, 0]),
    );
    const candidates = candidateIds(ALONG_Y, [...outliers, ...crowd(200)]);

    expect(candidates).toHaveLength(COSINE_TOP_K);
    expect(candidates[0]).toBe("out-00");
    expect(candidates).not.toContain("out-11");
  });

  test("orders candidates by descending similarity, breaking ties on id", () => {
    const candidates = candidateIds(ALONG_Y, [
      embedding("b-tied", [0, 1, 0]),
      embedding("a-tied", [0, 1, 0]),
      embedding("c-lower", [0.4, 1, 0]),
      ...crowd(20),
    ]);

    expect(candidates).toEqual(["a-tied", "b-tied", "c-lower"]);
  });

  test("reports each candidate's raw similarity, not the z it was gated on", () => {
    // Push injection floors on similarity: z answers "did this stand out from the
    // corpus", which is the right question for ranking and the wrong one for
    // deciding whether a learning is close enough to push at an agent unasked.
    const candidates = selectCosineCandidates(ALONG_Y, [embedding("outlier", [0, 1, 0]), ...crowd(9)]);

    expect(candidates).toEqual([{ id: "outlier", similarity: expect.any(Number) }]);
    expect(candidates[0]!.similarity).toBeCloseTo(1, 5);
  });
});
