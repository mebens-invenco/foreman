import type { WorkerResult } from "../domain/index.js";
import type { LiveBenchExpect } from "./cases/foreman-bench.js";
import type { Grader, GraderResult } from "./types.js";

/**
 * Graders for the live-bench reviewer cases (`reviewer-live`). Ported from the
 * scratchpad live-bench driver that produced the `baselines/*live-bench*`
 * evidence; detail strings keep the driver's formats so continuous-stat
 * scraping stays comparable across the recorded runs.
 *
 * The live cases exercise the discovery loop the synthetic `reviewer` eval
 * bypasses, so these graders check the end-to-end decision: the outcome the
 * fixture warrants, the single-COMMENT-review mutation shape, the planted file
 * pinned by an inline thread, thread-count discipline against nit-bait, and
 * body-vs-thread placement.
 */

const pass = (dimension: string, detail: string): GraderResult => ({ dimension, pass: true, detail });
const fail = (dimension: string, detail: string): GraderResult => ({ dimension, pass: false, detail });
const na = (dimension: string, detail: string): GraderResult => ({ dimension, pass: true, detail });

type SubmitReview = Extract<WorkerResult["reviewMutations"][number], { type: "submit_pull_request_review" }>;

const submitReviews = (result: WorkerResult): SubmitReview[] =>
  result.reviewMutations.filter((mutation): mutation is SubmitReview => mutation.type === "submit_pull_request_review");

export const liveOutcomeGrader: Grader<LiveBenchExpect> = {
  name: "outcome",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("outcome", "no parseable result to inspect");
    }
    return result.outcome === evalCase.expect.outcome
      ? pass("outcome", `got ${result.outcome}, want ${evalCase.expect.outcome}`)
      : fail("outcome", `got ${result.outcome}, want ${evalCase.expect.outcome}`);
  },
};

/**
 * Mutation shape: a `completed` review is exactly one `submit_pull_request_review`
 * with `event: "COMMENT"` and nothing else; a stand-down carries zero mutations
 * of either kind (fixture PRs are frozen — captured mutations are never applied,
 * but the reviewer must not even propose writes on a clean PR).
 */
export const liveMutationShapeGrader: Grader<LiveBenchExpect> = {
  name: "mutation-shape",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("mutation-shape", "no parseable result to inspect");
    }
    if (evalCase.expect.outcome === "no_action_needed") {
      const total = result.reviewMutations.length + result.taskMutations.length;
      return total === 0
        ? pass("mutation-shape", `review=${result.reviewMutations.length} task=${result.taskMutations.length}`)
        : fail("mutation-shape", `review=${result.reviewMutations.length} task=${result.taskMutations.length}`);
    }
    const sprs = submitReviews(result);
    const others = result.reviewMutations.filter((mutation) => mutation.type !== "submit_pull_request_review");
    const ok = sprs.length === 1 && sprs[0]?.event === "COMMENT" && others.length === 0 && result.taskMutations.length === 0;
    return ok
      ? pass("mutation-shape", `sprs=${sprs.length} others=none`)
      : fail("mutation-shape", `sprs=${sprs.length} others=${others.map((m) => m.type).join(",") || "none"} task=${result.taskMutations.length}`);
  },
};

/** Every planted file path must be pinned by at least one inline comment. */
export const livePlantedPathsGrader: Grader<LiveBenchExpect> = {
  name: "planted-paths",
  grade: ({ evalCase, result }) => {
    const mustFlag = evalCase.expect.mustFlagPaths ?? [];
    if (mustFlag.length === 0) {
      return na("planted-paths", "n/a (no planted paths)");
    }
    if (!result) {
      return fail("planted-paths", "no parseable result to inspect");
    }
    const comments = submitReviews(result).flatMap((review) => review.comments ?? []);
    const missing = mustFlag.filter((path) => !comments.some((comment) => comment.path === path));
    const seen = `comment paths: ${comments.map((comment) => comment.path).join(", ") || "none"}`;
    return missing.length === 0 ? pass("planted-paths", seen) : fail("planted-paths", `missing ${missing.join(", ")}; ${seen}`);
  },
};

export const liveThreadCountGrader: Grader<LiveBenchExpect> = {
  name: "thread-count",
  grade: ({ evalCase, result }) => {
    const maxThreads = evalCase.expect.maxThreads;
    if (maxThreads === undefined) {
      return na("thread-count", "n/a (no thread budget)");
    }
    if (!result) {
      return fail("thread-count", "no parseable result to inspect");
    }
    const count = submitReviews(result).flatMap((review) => review.comments ?? []).length;
    const detail = `${count} threads (max ${maxThreads})`;
    return count <= maxThreads ? pass("thread-count", detail) : fail("thread-count", detail);
  },
};

/** Findings live in threads: the body stays shorter than the largest inline comment. */
export const liveBodyDisciplineGrader: Grader<LiveBenchExpect> = {
  name: "body-discipline",
  grade: ({ evalCase, result }) => {
    if (evalCase.expect.outcome !== "completed") {
      return na("body-discipline", "n/a (not a completed review)");
    }
    if (!result) {
      return fail("body-discipline", "no parseable result to inspect");
    }
    const review = submitReviews(result)[0];
    const bodyLength = review?.body?.length ?? 0;
    const largestComment = Math.max(0, ...(review?.comments ?? []).map((comment) => comment.body.length));
    const detail = `body ${bodyLength}c vs largest comment ${largestComment}c`;
    return bodyLength < largestComment ? pass("body-discipline", detail) : fail("body-discipline", detail);
  },
};

export const liveSummaryLengthGrader: Grader<LiveBenchExpect> = {
  name: "summary-length",
  grade: ({ evalCase, result }) => {
    const maxChars = evalCase.expect.summaryMaxChars;
    if (maxChars === undefined) {
      return na("summary-length", "n/a (no summary ceiling)");
    }
    if (!result) {
      return fail("summary-length", "no parseable result to inspect");
    }
    const detail = `${result.summary.length}c (max ${maxChars})`;
    return result.summary.length <= maxChars ? pass("summary-length", detail) : fail("summary-length", detail);
  },
};

export const livePrGraders: Grader<LiveBenchExpect>[] = [
  liveOutcomeGrader,
  liveMutationShapeGrader,
  livePlantedPathsGrader,
  liveThreadCountGrader,
  liveBodyDisciplineGrader,
  liveSummaryLengthGrader,
];
