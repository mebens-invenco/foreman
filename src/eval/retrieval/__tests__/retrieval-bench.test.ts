import { describe, expect, test } from "vitest";

import { FakeEmbedder } from "../../../test-support/fake-embedder.js";
import { testProjectRoot } from "../../../test-support/helpers.js";
import { runRetrievalBench } from "../run.js";

// Fixture-pinned guard, always on and always offline. `FakeEmbedder` is a pure
// function of text and index, so the whole bench reproduces exactly under it —
// which makes it a real tripwire for the fusion, the cross-query merge, and the
// pagination, none of which care what the vectors mean.
//
// Two rows are pinned here, and they say different things:
//
//   fts  — the historical baseline. Any accidental fixture edit or scoring drift
//          moves it, which is precisely what this is here to make loud.
//   null — the same hybrid pipeline driven by a SEMANTICS-FREE embedder. It is
//          the padding floor: whatever recall this buys over `fts` was bought by
//          filling the result window with arbitrary rows, not by retrieval. It
//          must stay at zero, or the committed hybrid delta is partly a lottery.
//
// Do NOT relax these to make a change pass. The real-model accuracy numbers live
// in `retrieval-bench-hybrid.test.ts`.
describe("retrieval bench (committed FTS baseline and null-embedder floor)", () => {
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

  test("buys no recall from a semantics-free embedder", async () => {
    const { model, fts, hybrid } = await runBench();

    expect(model).toBe("fake-embedder-v1");
    // Identical recall to `fts`, and the same 11 cases still retrieve nothing:
    // the bounded cosine arm proposes only statistical outliers, and meaningless
    // vectors produce none that help. An unbounded arm scored 0.513 / 0.561 / 8
    // here — pure window padding.
    expect(hybrid.metrics).toEqual({
      labeledCases: 26,
      recallAt5: 0.474,
      recallAt10: 0.474,
      // Below `fts`'s 0.546 only because RRF merges queries by best rank while
      // `searchLearnings` merges by best bm25 score; the retrieved sets match.
      mrr: 0.462,
      zeroRecallCases: 11,
    });
    expect(hybrid.metrics.recallAt5).toBe(fts.metrics.recallAt5);
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
});
