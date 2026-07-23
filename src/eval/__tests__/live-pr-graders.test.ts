import { describe, expect, it } from "vitest";

import type { WorkerResult } from "../../domain/index.js";
import type { LiveBenchExpect } from "../cases/foreman-bench.js";
import { foremanBenchCases } from "../cases/foreman-bench.js";
import {
  liveBodyDisciplineGrader,
  liveMutationShapeGrader,
  liveOutcomeGrader,
  livePlantedPathsGrader,
  liveSummaryLengthGrader,
  liveThreadCountGrader,
} from "../live-pr-graders.js";
import type { EvalCase, GradeContext, Grader } from "../types.js";

// Deterministic ports of the scratchpad live-bench driver's checks; these pin
// the grading behavior against the same expectations the recorded
// baselines/*live-bench* evidence was graded with.

const plantedCase = foremanBenchCases.find((c) => c.expect.outcome === "completed")!;
const cleanCase = foremanBenchCases.find((c) => c.expect.outcome === "no_action_needed")!;
const plantedPath = plantedCase.expect.mustFlagPaths![0]!;

type ReviewMutation = WorkerResult["reviewMutations"][number];

const makeResult = (over: Partial<WorkerResult>): WorkerResult => ({
  schemaVersion: 1,
  action: "reviewer",
  outcome: "no_action_needed",
  summary: "Reviewed the current diff; no reportable findings.",
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [],
  blockers: [],
  signals: [],
  ...over,
});

const submitReview = (over: { event?: string; body?: string; comments?: { path: string; line: number; body: string }[] }): ReviewMutation =>
  ({
    type: "submit_pull_request_review",
    event: over.event ?? "COMMENT",
    body: over.body ?? "One finding captured inline.",
    comments: over.comments ?? [{ path: plantedPath, line: 21, body: "x".repeat(400) }],
  }) as ReviewMutation;

const completedResult = (over: { event?: string; body?: string; comments?: { path: string; line: number; body: string }[] } = {}): WorkerResult =>
  makeResult({ outcome: "completed", reviewMutations: [submitReview(over)] });

const ctxFor = (evalCase: EvalCase<LiveBenchExpect>, result: WorkerResult | null): GradeContext<LiveBenchExpect> => ({
  evalCase,
  result,
  rawStdout: "",
  ...(result ? {} : { parseError: "parse failed" }),
});

const passOf = async (grader: Grader<LiveBenchExpect>, ctx: GradeContext<LiveBenchExpect>): Promise<boolean> => (await grader.grade(ctx)).pass;

describe("foremanBenchCases", () => {
  it("loads every manifest case as a live-pr fixture pinned to a head sha", () => {
    expect(foremanBenchCases.length).toBeGreaterThanOrEqual(3);
    for (const evalCase of foremanBenchCases) {
      expect(evalCase.fixture.type).toBe("live-pr");
      if (evalCase.fixture.type === "live-pr") {
        expect(evalCase.fixture.headSha).toMatch(/^[0-9a-f]{40}$/);
        expect(evalCase.fixture.repo).toBe("invenco/foreman-bench");
      }
    }
  });
});

describe("liveOutcomeGrader", () => {
  describe("when the outcome matches the fixture expectation", () => {
    it("passes", async () => {
      expect(await passOf(liveOutcomeGrader, ctxFor(cleanCase, makeResult({})))).toBe(true);
    });
  });

  describe("when the reviewer completes a review on the clean PR", () => {
    it("fails", async () => {
      expect(await passOf(liveOutcomeGrader, ctxFor(cleanCase, completedResult()))).toBe(false);
    });
  });

  describe("when the result did not parse", () => {
    it("fails", async () => {
      expect(await passOf(liveOutcomeGrader, ctxFor(cleanCase, null))).toBe(false);
    });
  });
});

describe("liveMutationShapeGrader", () => {
  describe("when a stand-down carries zero mutations", () => {
    it("passes", async () => {
      expect(await passOf(liveMutationShapeGrader, ctxFor(cleanCase, makeResult({})))).toBe(true);
    });
  });

  describe("when a stand-down still proposes a review mutation", () => {
    it("fails", async () => {
      const result = makeResult({ reviewMutations: [submitReview({})] });
      expect(await passOf(liveMutationShapeGrader, ctxFor(cleanCase, result))).toBe(false);
    });
  });

  describe("when a completed review is exactly one COMMENT submit", () => {
    it("passes", async () => {
      expect(await passOf(liveMutationShapeGrader, ctxFor(plantedCase, completedResult()))).toBe(true);
    });
  });

  describe("when the completed review uses a non-COMMENT event", () => {
    it("fails", async () => {
      expect(await passOf(liveMutationShapeGrader, ctxFor(plantedCase, completedResult({ event: "REQUEST_CHANGES" })))).toBe(false);
    });
  });
});

describe("livePlantedPathsGrader", () => {
  describe("when an inline comment pins the planted file", () => {
    it("passes", async () => {
      expect(await passOf(livePlantedPathsGrader, ctxFor(plantedCase, completedResult()))).toBe(true);
    });
  });

  describe("when no comment touches the planted file", () => {
    it("fails", async () => {
      const result = completedResult({ comments: [{ path: "src/other/File.ts", line: 3, body: "x".repeat(300) }] });
      expect(await passOf(livePlantedPathsGrader, ctxFor(plantedCase, result))).toBe(false);
    });
  });

  describe("when the case plants no finding", () => {
    it("reports n/a as a pass", async () => {
      const graded = await livePlantedPathsGrader.grade(ctxFor(cleanCase, makeResult({})));
      expect(graded.pass).toBe(true);
      expect(graded.detail).toContain("n/a");
    });
  });
});

describe("liveThreadCountGrader", () => {
  describe("when the thread count stays within the budget", () => {
    it("passes", async () => {
      expect(await passOf(liveThreadCountGrader, ctxFor(plantedCase, completedResult()))).toBe(true);
    });
  });

  describe("when nit-bait balloons the thread count past the budget", () => {
    it("fails", async () => {
      const comments = Array.from({ length: (plantedCase.expect.maxThreads ?? 3) + 1 }, (_, i) => ({
        path: plantedPath,
        line: i + 1,
        body: "x".repeat(200),
      }));
      expect(await passOf(liveThreadCountGrader, ctxFor(plantedCase, completedResult({ comments })))).toBe(false);
    });
  });
});

describe("liveBodyDisciplineGrader", () => {
  describe("when the body stays shorter than the largest inline comment", () => {
    it("passes", async () => {
      expect(await passOf(liveBodyDisciplineGrader, ctxFor(plantedCase, completedResult({ body: "Short." })))).toBe(true);
    });
  });

  describe("when the body outgrows every inline comment", () => {
    it("fails", async () => {
      const result = completedResult({ body: "y".repeat(500), comments: [{ path: plantedPath, line: 2, body: "short" }] });
      expect(await passOf(liveBodyDisciplineGrader, ctxFor(plantedCase, result))).toBe(false);
    });
  });

  describe("when the case is a stand-down", () => {
    it("reports n/a as a pass", async () => {
      const graded = await liveBodyDisciplineGrader.grade(ctxFor(cleanCase, makeResult({})));
      expect(graded.pass).toBe(true);
      expect(graded.detail).toContain("n/a");
    });
  });
});

describe("liveSummaryLengthGrader", () => {
  describe("when the stand-down summary stays under the ceiling", () => {
    it("passes", async () => {
      expect(await passOf(liveSummaryLengthGrader, ctxFor(cleanCase, makeResult({})))).toBe(true);
    });
  });

  describe("when the stand-down summary exceeds the ceiling", () => {
    it("fails", async () => {
      const result = makeResult({ summary: "z".repeat((cleanCase.expect.summaryMaxChars ?? 450) + 1) });
      expect(await passOf(liveSummaryLengthGrader, ctxFor(cleanCase, result))).toBe(false);
    });
  });
});
