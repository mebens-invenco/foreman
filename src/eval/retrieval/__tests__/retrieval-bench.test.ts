import { describe, expect, test } from "vitest";

import { testProjectRoot } from "../../../test-support/helpers.js";
import { runRetrievalBench } from "../run.js";

// Fixture-pinned guard: the committed corpus + cases + FTS pipeline produce an
// exact baseline. Any accidental fixture edit or scoring drift changes these
// numbers, which is precisely what this test is here to make loud. The values
// mirror src/eval/retrieval/README.md — do NOT relax them to make a change pass;
// a retrieval improvement should be measured against these, not overwrite them.
describe("retrieval bench (committed FTS baseline)", () => {
  test("reproduces the fixture-pinned baseline metrics exactly", () => {
    const { metrics } = runRetrievalBench({ projectRoot: testProjectRoot });
    expect(metrics).toEqual({
      labeledCases: 26,
      recallAt5: 0.474,
      recallAt10: 0.474,
      mrr: 0.546,
      zeroRecallCases: 11,
    });
  });

  test("scores every labeled case and no distractor (zero-expected) case", () => {
    const { perCase } = runRetrievalBench({ projectRoot: testProjectRoot });
    expect(perCase).toHaveLength(26);
    expect(perCase.every((row) => row.expected > 0)).toBe(true);
  });
});
