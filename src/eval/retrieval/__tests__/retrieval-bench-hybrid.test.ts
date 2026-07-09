import { describe, expect, test } from "vitest";

import { createEmbedder } from "../../../embeddings/create-embedder.js";
import { testProjectRoot } from "../../../test-support/helpers.js";
import { runRetrievalBench } from "../run.js";

// Opt-in: the real-model ACCURACY guard, and the only test allowed to touch the
// real model. It is skipped by default because the first run downloads ~133MB —
// `pnpm test` must stay offline and fast.
//
//   FOREMAN_BENCH_REAL_EMBEDDER=1 pnpm test retrieval-bench-hybrid
//
// This is not the only guard on the fusion: `retrieval-bench.test.ts` pins the
// same pipeline under `FakeEmbedder` on every run, which catches a broken merge,
// a sign-flipped fusion, or a pagination regression without a model. What only
// the real model can tell you is whether the ranking is any *good* — that is
// what lives here.
//
// Run it whenever retrieval ranking, fusion, or the embedded text changes. The
// numbers mirror src/eval/retrieval/README.md; bge-small inference is
// deterministic per model version, so a drift here is a real regression, not
// noise. Do NOT relax them to make a change pass.
const optedIn = process.env.FOREMAN_BENCH_REAL_EMBEDDER === "1";

describe.skipIf(!optedIn)("retrieval bench (committed hybrid numbers, real model)", () => {
  test("beats the FTS baseline on the pinned fixtures", async () => {
    const { model, fts, hybrid } = await runRetrievalBench({
      projectRoot: testProjectRoot,
      embedder: createEmbedder(testProjectRoot),
    });

    expect(model).toBe("bge-small-en-v1.5");

    // Same fixtures, same scope, same scorer — so the FTS side must still land
    // on its historical baseline, or the delta below is not attributable to the
    // fusion.
    expect(fts.metrics).toEqual({
      labeledCases: 26,
      recallAt5: 0.474,
      recallAt10: 0.474,
      mrr: 0.546,
      zeroRecallCases: 11,
    });

    expect(hybrid.metrics).toEqual({
      labeledCases: 26,
      recallAt5: 0.676,
      recallAt10: 0.696,
      mrr: 0.721,
      zeroRecallCases: 3,
    });

    // The lift must be semantic, not padding: a semantics-free embedder scores
    // exactly `fts` on recall (pinned in retrieval-bench.test.ts), so every point
    // of this margin is attributable to the model.
    expect(hybrid.metrics.recallAt5).toBeGreaterThan(fts.metrics.recallAt5);
  }, 120_000);
});
