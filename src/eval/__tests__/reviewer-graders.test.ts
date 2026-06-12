import { describe, expect, it } from "vitest";

import type { WorkerResult } from "../../domain/index.js";
import type { ReviewerExpect } from "../cases/reviewer.js";
import { reviewerCases } from "../cases/reviewer.js";
import {
  reviewerBodyDisciplineGrader,
  reviewerMentionGrader,
  reviewerOutcomeGrader,
  reviewerSummaryConcisenessGrader,
  reviewMutationConformanceGrader,
} from "../reviewer-graders.js";
import type { EvalCase, GradeContext, Grader } from "../types.js";

// All reviewer graders are deterministic (no judge — see reviewer-graders.ts).
// These pin the empirical bars from src/eval/analysis/reviewer-error-analysis.md:
// the 450c/3-sentence stand-down ceiling, the 900c finding-in-body tripwire, the
// body<thread inversion, and the structural conformance the 23 real completed
// traces were 100% clean on.

const standDownCase = reviewerCases.find((c) => c.expect.outcome === "no_action_needed")!;
const completedCase = reviewerCases.find((c) => c.expect.outcome === "completed")!;

const makeCase = (over: Partial<EvalCase<ReviewerExpect>>): EvalCase<ReviewerExpect> => ({ ...standDownCase, ...over });

type ReviewMutation = WorkerResult["reviewMutations"][number];
type TaskMutation = WorkerResult["taskMutations"][number];

const makeResult = (over: Partial<WorkerResult>): WorkerResult => ({
  schemaVersion: 1,
  action: "reviewer",
  outcome: "no_action_needed",
  summary: "Nothing new since the checkpoint; checks green.",
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
    body: over.body ?? "One thread raised on the error path; otherwise solid.",
    comments: over.comments ?? [{ path: "src/modules/carrierRate/appServices/persistCacheEntry.ts", line: 7, body: "x".repeat(950) }],
  }) as ReviewMutation;

const ctxFor = (evalCase: EvalCase<ReviewerExpect>, result: WorkerResult | null): GradeContext<ReviewerExpect> => ({
  evalCase,
  result,
  rawStdout: "",
  ...(result ? {} : { parseError: "parse failed" }),
});

const passOf = async (grader: Grader<ReviewerExpect>, ctx: GradeContext<ReviewerExpect>): Promise<boolean> => (await grader.grade(ctx)).pass;

describe("reviewerOutcomeGrader", () => {
  describe("when the emitted outcome matches the expectation", () => {
    it("passes", async () => {
      expect(await passOf(reviewerOutcomeGrader, ctxFor(standDownCase, makeResult({})))).toBe(true);
    });
  });

  describe("when the emitted outcome differs", () => {
    it("fails", async () => {
      expect(await passOf(reviewerOutcomeGrader, ctxFor(standDownCase, makeResult({ outcome: "completed" })))).toBe(false);
    });
  });

  describe("when there is no parseable result", () => {
    it("fails", async () => {
      expect(await passOf(reviewerOutcomeGrader, ctxFor(standDownCase, null))).toBe(false);
    });
  });
});

describe("reviewMutationConformanceGrader", () => {
  describe("when a stand-down carries zero mutations", () => {
    it("passes", async () => {
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(standDownCase, makeResult({})))).toBe(true);
    });
  });

  describe("when a stand-down carries a review mutation", () => {
    it("fails", async () => {
      const result = makeResult({ reviewMutations: [submitReview({})] });
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(standDownCase, result))).toBe(false);
    });
  });

  describe("when the reviewer emits a task mutation", () => {
    // reviewer.md forbids requesting changes via task mutations; 0/123 real
    // traces carried any.
    it("fails regardless of outcome", async () => {
      const mutation = { type: "add_comment", taskId: "EVAL-R001", body: "please fix" } as unknown as TaskMutation;
      const result = makeResult({ taskMutations: [mutation] });
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(standDownCase, result))).toBe(false);
    });
  });

  describe("when a completed review is exactly one COMMENT submit with pinned comments", () => {
    it("passes", async () => {
      const result = makeResult({ outcome: "completed", reviewMutations: [submitReview({})] });
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(completedCase, result))).toBe(true);
    });
  });

  describe("when a completed review carries no mutation", () => {
    it("fails", async () => {
      const result = makeResult({ outcome: "completed" });
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(completedCase, result))).toBe(false);
    });
  });

  describe("when a completed review uses a non-COMMENT event", () => {
    it("fails", async () => {
      const result = makeResult({ outcome: "completed", reviewMutations: [submitReview({ event: "REQUEST_CHANGES" })] });
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(completedCase, result))).toBe(false);
    });
  });

  describe("when a completed review has zero inline comments", () => {
    // Actionable findings live in inline threads (reviewer.md); a body-only
    // review is the finding-in-body anti-pattern's structural twin.
    it("fails", async () => {
      const result = makeResult({ outcome: "completed", reviewMutations: [submitReview({ comments: [] })] });
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(completedCase, result))).toBe(false);
    });
  });

  describe("when an inline comment is missing its line pin", () => {
    it("fails", async () => {
      const result = makeResult({
        outcome: "completed",
        reviewMutations: [submitReview({ comments: [{ path: "src/a.ts", line: 0, body: "unpinned" }] })],
      });
      expect(await passOf(reviewMutationConformanceGrader, ctxFor(completedCase, result))).toBe(false);
    });
  });
});

describe("reviewerSummaryConcisenessGrader", () => {
  describe("when a stand-down summary sits within the standard ceiling", () => {
    it("passes at the observed-good shape (≤3 sentences, ≤450 chars)", async () => {
      const result = makeResult({ summary: "Nothing new since the checkpoint. Checks green. Standing down." });
      expect(await passOf(reviewerSummaryConcisenessGrader, ctxFor(standDownCase, result))).toBe(true);
    });
  });

  describe("when a stand-down summary exceeds the char ceiling", () => {
    // The summary-overlong mode: 24 real continuation bads, tail at 788c.
    it("fails above 450 chars", async () => {
      const result = makeResult({ summary: `Nothing new since the checkpoint, ${"specifically ".repeat(40)}.` });
      expect(await passOf(reviewerSummaryConcisenessGrader, ctxFor(standDownCase, result))).toBe(false);
    });
  });

  describe("when a stand-down summary exceeds the sentence ceiling", () => {
    it("fails above 3 sentences", async () => {
      const result = makeResult({ summary: "One fact. Two facts. Three facts. Four facts." });
      expect(await passOf(reviewerSummaryConcisenessGrader, ctxFor(standDownCase, result))).toBe(false);
    });
  });

  describe("when the case expects a completed review", () => {
    it("is n/a and passes (body discipline owns that dimension)", async () => {
      const result = makeResult({ outcome: "completed", summary: "x".repeat(600) });
      expect(await passOf(reviewerSummaryConcisenessGrader, ctxFor(completedCase, result))).toBe(true);
    });
  });
});

describe("reviewerBodyDisciplineGrader", () => {
  describe("when the body is short and lighter than its largest thread", () => {
    it("passes (good shape: body median 449c < thread median 962c)", async () => {
      const result = makeResult({ outcome: "completed", reviewMutations: [submitReview({})] });
      expect(await passOf(reviewerBodyDisciplineGrader, ctxFor(completedCase, result))).toBe(true);
    });
  });

  describe("when the body crosses the finding-in-body tripwire", () => {
    // The 3 real bads were 1038-1387c; good bodies max 682c.
    it("fails above 900 chars", async () => {
      const result = makeResult({ outcome: "completed", reviewMutations: [submitReview({ body: "y".repeat(1038) })] });
      expect(await passOf(reviewerBodyDisciplineGrader, ctxFor(completedCase, result))).toBe(false);
    });
  });

  describe("when the body outweighs its largest inline comment", () => {
    it("fails on the body ≥ thread inversion", async () => {
      const result = makeResult({
        outcome: "completed",
        reviewMutations: [submitReview({ body: "z".repeat(700), comments: [{ path: "src/a.ts", line: 3, body: "short thread" }] })],
      });
      expect(await passOf(reviewerBodyDisciplineGrader, ctxFor(completedCase, result))).toBe(false);
    });
  });

  describe("when the case expects a stand-down", () => {
    it("is n/a and passes", async () => {
      expect(await passOf(reviewerBodyDisciplineGrader, ctxFor(standDownCase, makeResult({})))).toBe(true);
    });
  });
});

describe("reviewerMentionGrader", () => {
  describe("when every expected path is pinned by an inline comment", () => {
    it("passes", async () => {
      const result = makeResult({ outcome: "completed", reviewMutations: [submitReview({})] });
      const evalCase = makeCase({ expect: { outcome: "completed", mustPinPath: ["persistCacheEntry.ts"] } });
      expect(await passOf(reviewerMentionGrader, ctxFor(evalCase, result))).toBe(true);
    });
  });

  describe("when an expected path is not pinned", () => {
    it("fails", async () => {
      const result = makeResult({ outcome: "completed", reviewMutations: [submitReview({})] });
      const evalCase = makeCase({ expect: { outcome: "completed", mustPinPath: ["some/other/file.ts"] } });
      expect(await passOf(reviewerMentionGrader, ctxFor(evalCase, result))).toBe(false);
    });
  });

  describe("when the case sets no path expectations", () => {
    it("passes", async () => {
      expect(await passOf(reviewerMentionGrader, ctxFor(standDownCase, makeResult({})))).toBe(true);
    });
  });
});
