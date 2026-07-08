import { describe, expect, test } from "vitest";

import { aggregateMetrics, scoreCase } from "../score.js";

describe("scoreCase", () => {
  test("hit at rank 1 → full recall and MRR 1", () => {
    expect(scoreCase(["a", "b", "c"], ["a"])).toEqual({ recallAt5: 1, recallAt10: 1, mrr: 1 });
  });

  test("hit at rank 6 → outside top-5, inside top-10, MRR 1/6", () => {
    const ranked = ["x1", "x2", "x3", "x4", "x5", "a", "x7"];
    const score = scoreCase(ranked, ["a"]);
    expect(score.recallAt5).toBe(0);
    expect(score.recallAt10).toBe(1);
    expect(score.mrr).toBeCloseTo(1 / 6, 10);
  });

  test("no hit anywhere → all zero", () => {
    expect(scoreCase(["x", "y", "z"], ["a", "b"])).toEqual({ recallAt5: 0, recallAt10: 0, mrr: 0 });
  });

  test("multi-expected partial → recall is the fraction found", () => {
    // expected {a, b}; a is at rank 1, b never retrieved.
    const score = scoreCase(["a", "x", "y", "z"], ["a", "b"]);
    expect(score.recallAt5).toBe(0.5);
    expect(score.recallAt10).toBe(0.5);
    expect(score.mrr).toBe(1);
  });

  test("hit beyond rank 10 → zero recall@10, but MRR still reflects the full-list rank", () => {
    // "a" sits at rank 11: outside the top-10 recall window, yet MRR is 1/rank
    // over the whole ranked list (not clamped to k), matching the baseline.
    const ranked = [...Array(10).keys()].map((i) => `x${i}`).concat("a");
    const score = scoreCase(ranked, ["a"]);
    expect(score.recallAt5).toBe(0);
    expect(score.recallAt10).toBe(0);
    expect(score.mrr).toBeCloseTo(1 / 11, 10);
  });
});

describe("aggregateMetrics", () => {
  test("averages raw per-case scores then rounds to 3dp; counts zero-recall@10 cases", () => {
    const metrics = aggregateMetrics([
      { recallAt5: 1, recallAt10: 1, mrr: 1 },
      { recallAt5: 0, recallAt10: 0, mrr: 0 },
      { recallAt5: 0, recallAt10: 1, mrr: 1 / 3 },
    ]);
    expect(metrics).toEqual({
      labeledCases: 3,
      recallAt5: 0.333,
      recallAt10: 0.667,
      mrr: 0.444,
      zeroRecallCases: 1,
    });
  });

  test("empty input yields zeroed metrics rather than NaN", () => {
    expect(aggregateMetrics([])).toEqual({
      labeledCases: 0,
      recallAt5: 0,
      recallAt10: 0,
      mrr: 0,
      zeroRecallCases: 0,
    });
  });
});
