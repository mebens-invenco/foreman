import { describe, expect, it } from "vitest";

import { formatEvalReport } from "../run.js";
import type { EvalReport, GraderResult, SampleResult } from "../types.js";

// Pure report-formatting tests — no live model. These lock the two behaviours
// the binary-judge + per-dimension-reporting change introduced:
//  1. each dimension's pass-rate is reported across ALL samples (not one sample);
//  2. the advisory judge is marked and does NOT drag the headline pass-rate.

const sample = (index: number, graderResults: GraderResult[], pass: boolean): SampleResult => ({
  sampleIndex: index,
  parsed: true,
  graderResults,
  pass,
});

// A case whose gating graders pass on every sample, but whose advisory judge
// flaps (fails sample 0, passes sample 1). The sample still passes because
// advisory dimensions don't gate — so the case pass-rate is 100%.
const report: EvalReport = {
  prompt: "learning-policy",
  runner: "claude",
  model: "claude-test",
  samplesPerCase: 2,
  overallPassRate: 1,
  cases: [
    {
      caseId: "reusable-insight",
      description: "reusable insight should produce a well-formed learning",
      passRate: 1,
      samples: [
        sample(
          0,
          [
            { dimension: "schema", pass: true, detail: "ok" },
            { dimension: "quality", pass: false, advisory: true, detail: "borderline restatement" },
          ],
          true,
        ),
        sample(
          1,
          [
            { dimension: "schema", pass: true, detail: "ok" },
            { dimension: "quality", pass: true, advisory: true, detail: "reusable rule" },
          ],
          true,
        ),
      ],
    },
  ],
};

describe("formatEvalReport", () => {
  const output = formatEvalReport(report);

  it("reports each dimension's pass-rate across all samples", () => {
    expect(output).toContain("schema: 100% (2/2)");
    expect(output).toContain("50% (1/2)");
  });

  it("marks the advisory judge dimension", () => {
    expect(output).toContain("quality (advisory): 50% (1/2)");
  });

  it("does not let the advisory dimension drag the headline pass-rate", () => {
    expect(output).toContain("Overall pass-rate: 100%");
    expect(output).toContain("• reusable-insight — 100%");
  });
});
