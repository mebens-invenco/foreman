import { describe, expect, test } from "vitest";

import { FakeEmbedder } from "../../../test-support/fake-embedder.js";
import { testProjectRoot } from "../../../test-support/helpers.js";
import { runRetrievalBench } from "../run.js";

// Fixture-pinned guard: the committed corpus + cases + FTS pipeline produce an
// exact baseline. Any accidental fixture edit or scoring drift changes these
// numbers, which is precisely what this test is here to make loud. The values
// mirror src/eval/retrieval/README.md — do NOT relax them to make a change pass;
// a retrieval improvement should be measured against these, not overwrite them.
//
// The FTS half is model-free, so a fake embedder runs the bench offline here.
// The hybrid numbers depend on the real bge-small model, which tests must never
// download; `retrieval-bench-hybrid.test.ts` pins those behind an opt-in flag.
describe("retrieval bench (committed FTS baseline)", () => {
  const runBench = () => runRetrievalBench({ projectRoot: testProjectRoot, embedder: new FakeEmbedder() });

  test("reproduces the fixture-pinned FTS baseline metrics exactly", async () => {
    const { fts } = await runBench();
    expect(fts.metrics).toEqual({
      labeledCases: 26,
      recallAt5: 0.474,
      recallAt10: 0.474,
      mrr: 0.546,
      zeroRecallCases: 11,
    });
  });

  test("scores every labeled case and no distractor (zero-expected) case, per pipeline", async () => {
    const { fts, hybrid } = await runBench();
    for (const perCase of [fts.perCase, hybrid.perCase]) {
      expect(perCase).toHaveLength(26);
      expect(perCase.every((row) => row.expected > 0)).toBe(true);
    }

    // Both pipelines answer the same cases in the same order, which is what lets
    // `formatRetrievalReport` zip them into one per-case row.
    expect(hybrid.perCase.map((row) => row.taskId)).toEqual(fts.perCase.map((row) => row.taskId));
  });

  test("reports a fully-formed metrics object for the hybrid pipeline", async () => {
    const { model, hybrid } = await runBench();

    expect(model).toBe("fake-embedder-v1");
    expect(hybrid.metrics).toEqual({
      labeledCases: 26,
      recallAt5: expect.any(Number),
      recallAt10: expect.any(Number),
      mrr: expect.any(Number),
      zeroRecallCases: expect.any(Number),
    });
  });
});
