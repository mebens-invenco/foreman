import { describe, expect, test } from "vitest";

import { fuseByReciprocalRank, RRF_K } from "../reciprocal-rank-fusion.js";

const rankedIdsByScore = (fused: Map<string, number>): string[] =>
  Array.from(fused).sort(([, leftScore], [, rightScore]) => rightScore - leftScore).map(([id]) => id);

describe("fuseByReciprocalRank", () => {
  test("scores an id by 1/(k + 1-based rank) summed over the lists it appears in", () => {
    const fused = fuseByReciprocalRank([["a", "b"], ["b"]]);

    expect(fused.get("a")).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused.get("b")).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
  });

  test("ranks an id agreed on by both lists above an id either list ranks first alone", () => {
    // `agreed` is second in both lists; `topOfOne` leads one list and is absent
    // from the other. Agreement across pipelines is the signal RRF is buying.
    const fused = fuseByReciprocalRank([
      ["topOfOne", "agreed"],
      ["onlyOther", "agreed"],
    ]);

    expect(rankedIdsByScore(fused)[0]).toBe("agreed");
  });

  test("gives ids absent from a list no contribution from it", () => {
    const fused = fuseByReciprocalRank([["a"], ["b"]]);

    expect(fused.get("a")).toBe(fused.get("b"));
  });

  test("preserves the input order when fusing a single list", () => {
    expect(rankedIdsByScore(fuseByReciprocalRank([["a", "b", "c"]]))).toEqual(["a", "b", "c"]);
  });

  test("fuses no lists, and empty lists, into an empty result", () => {
    expect(fuseByReciprocalRank([])).toEqual(new Map());
    expect(fuseByReciprocalRank([[], []])).toEqual(new Map());
  });

  test("damps the head of a list less as k shrinks", () => {
    // k is what stops one list's rank-1 hit from swamping the fusion. At k=0 the
    // top rank is worth 1.0; at k=60 it is worth ~0.016 — the same order of
    // magnitude as rank 2, which is why agreement can outvote a single leader.
    expect(fuseByReciprocalRank([["a"]], 0).get("a")).toBe(1);
    expect(fuseByReciprocalRank([["a"]], RRF_K).get("a")).toBeCloseTo(0.0164, 4);
  });
});
