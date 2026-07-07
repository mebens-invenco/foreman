import type { WorkerResult } from "../domain/index.js";
import type { ReviewerExpect } from "./cases/reviewer.js";
import { countSentences, makeSchemaGrader, normalizeForMention, SUMMARY_LENGTH_BARS } from "./graders.js";
import type { Grader, GraderResult } from "./types.js";

/**
 * Graders for the reviewer action (`prompts/templates/reviewer.md` +
 * `reviewer-continuation.md`). The worker-result schema enforces only the
 * coarse shape (a completed review carries mutations; a non-empty summary), so
 * the behavioral bars the reviewer prompt sets — concise stand-down summaries,
 * findings in threads not the body, exactly-one COMMENT review — are enforced
 * here. Every constant traces to `src/eval/analysis/reviewer-error-analysis.md`.
 *
 * Deliberately NOT built (analysis §"Implications" #5 + §Signals): a judge
 * grader (the reviewer's verdict was 0/123 wrong and is un-re-derivable from the
 * harvest, so there is nothing to calibrate a judge against) and a signals
 * grader (signal emission is a harness/schema-era artifact, orthogonal to the
 * reviewer's behavioral job).
 */

const pass = (dimension: string, detail: string): GraderResult => ({ dimension, pass: true, detail });
const fail = (dimension: string, detail: string): GraderResult => ({ dimension, pass: false, detail });

type SubmitReview = Extract<WorkerResult["reviewMutations"][number], { type: "submit_pull_request_review" }>;

const submitReviews = (result: WorkerResult): SubmitReview[] =>
  result.reviewMutations.filter((mutation): mutation is SubmitReview => mutation.type === "submit_pull_request_review");

/** The emitted outcome matches what the PR state warrants. */
export const reviewerOutcomeGrader: Grader<ReviewerExpect> = {
  name: "outcome",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("outcome", "no parseable result to inspect");
    }
    return result.outcome === evalCase.expect.outcome
      ? pass("outcome", `outcome is "${result.outcome}" as expected`)
      : fail("outcome", `expected outcome "${evalCase.expect.outcome}" but got "${result.outcome}"`);
  },
};

/**
 * Review-mutation structural conformance. Provenance: analysis §3 (regression
 * guard, 100% clean across the 23 real completed traces):
 *   - `no_action_needed` → ZERO reviewMutations.
 *   - `completed` → exactly one `submit_pull_request_review`, `event: "COMMENT"`,
 *     ≥1 inline comment each with a path + line, and no reply/resolve mutation
 *     type (the reviewer never replies to or resolves existing threads — 0/123).
 * In both cases `taskMutations` must be empty (observed 0/123; reviewer.md
 * forbids requesting changes via task mutations).
 */
export const reviewMutationConformanceGrader: Grader<ReviewerExpect> = {
  name: "review-mutation",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("review-mutation", "no parseable result to inspect");
    }
    if (result.taskMutations.length > 0) {
      return fail("review-mutation", `reviewer must not emit task mutations (reviewer.md), found ${result.taskMutations.length}`);
    }

    if (evalCase.expect.outcome === "no_action_needed") {
      return result.reviewMutations.length === 0
        ? pass("review-mutation", "no_action_needed with zero review mutations, as required")
        : fail("review-mutation", `no_action_needed must carry zero review mutations, found ${result.reviewMutations.length}`);
    }

    // completed: exactly one submit_pull_request_review and nothing else.
    if (result.reviewMutations.length !== 1) {
      return fail("review-mutation", `completed review must carry exactly one review mutation, found ${result.reviewMutations.length}`);
    }
    const submits = submitReviews(result);
    if (submits.length !== 1) {
      const types = result.reviewMutations.map((mutation) => mutation.type).join(", ");
      return fail("review-mutation", `the single review mutation must be submit_pull_request_review (no reply/resolve), found [${types}]`);
    }
    const submit = submits[0]!;
    if (submit.event !== "COMMENT") {
      return fail("review-mutation", `review event must be COMMENT, found "${submit.event}"`);
    }
    if (submit.comments.length === 0) {
      return fail("review-mutation", "completed review must carry ≥1 inline comment");
    }
    for (const comment of submit.comments) {
      if (!comment.path || comment.path.trim().length === 0) {
        return fail("review-mutation", "an inline comment is missing its file path");
      }
      if (!Number.isInteger(comment.line) || comment.line <= 0) {
        return fail("review-mutation", `an inline comment on "${comment.path}" is missing a positive line`);
      }
    }
    return pass("review-mutation", `one COMMENT review with ${submit.comments.length} inline comment(s), each path+line pinned`);
  },
};

/**
 * Stand-down summary conciseness (only graded for `no_action_needed`). Provenance:
 * the committed summary-policy standard bar (≤3 sentences AND ≤450 chars, p95 of
 * good = 444c — `SUMMARY_LENGTH_BARS.standard`), and the reviewer corpus's own
 * first_pass no_action summaries max out at 363c (analysis §"no_action summary
 * length"). A ceiling, never a floor: a short stand-down always passes. Completed
 * reviews are out of scope here — their body discipline is graded separately.
 */
export const reviewerSummaryConcisenessGrader: Grader<ReviewerExpect> = {
  name: "summary-conciseness",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("summary-conciseness", "no parseable result to inspect");
    }
    if (evalCase.expect.outcome !== "no_action_needed") {
      return pass("summary-conciseness", "n/a (not a stand-down)");
    }
    const bar = SUMMARY_LENGTH_BARS.standard;
    const chars = result.summary.length;
    const sentences = countSentences(result.summary);
    if (chars > bar.maxChars) {
      return fail("summary-conciseness", `stand-down summary is ${chars} chars; standard ceiling is ${bar.maxChars}`);
    }
    if (sentences > bar.maxSentences) {
      return fail("summary-conciseness", `stand-down summary is ${sentences} sentences; standard ceiling is ${bar.maxSentences}`);
    }
    return pass("summary-conciseness", `${chars} chars / ${sentences} sentence(s), within the standard stand-down ceiling`);
  },
};

/**
 * Empirical body-discipline ceiling for a completed review's top-level body.
 * Provenance: analysis §2 + "Empirical bars": good completed bodies max at 682c
 * (the 3 finding-in-body bads are 1038–1387c), and a good review inverts the bad
 * pattern — body < largest inline thread (good inline threads median 962c). So a
 * disciplined body is ≤900c AND shorter than its largest inline comment.
 */
const BODY_MAX_CHARS = 900;

/**
 * Body discipline (only graded for `completed`). The actionable detail belongs
 * in the inline thread; the top-level body is a short orientation paragraph.
 * Tripwires from analysis §2: body >900c, or body ≥ its largest inline comment.
 */
export const reviewerBodyDisciplineGrader: Grader<ReviewerExpect> = {
  name: "body-discipline",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("body-discipline", "no parseable result to inspect");
    }
    if (evalCase.expect.outcome !== "completed") {
      return pass("body-discipline", "n/a (not a completed review)");
    }
    const submits = submitReviews(result);
    const submit = submits[0];
    if (!submit) {
      // The conformance grader owns this failure; here it is simply n/a.
      return pass("body-discipline", "n/a (no submit_pull_request_review to inspect)");
    }
    const bodyChars = submit.body.length;
    if (bodyChars > BODY_MAX_CHARS) {
      return fail("body-discipline", `review body is ${bodyChars} chars; the finding-in-body tripwire is ${BODY_MAX_CHARS} (good bodies max 682c)`);
    }
    const largestComment = submit.comments.reduce((max, comment) => Math.max(max, comment.body.length), 0);
    // `largestComment > 0` is belt-and-suspenders — the conformance grader already
    // requires ≥1 inline comment and the schema forces `body.min(1)`, so it is never 0
    // here. The inversion is strict (`>=`) and empirically safe: good comments cluster
    // at ≥498c, well above disciplined bodies. It could in principle fail a legitimately
    // tiny review (e.g. a 200c body == a single 200c comment); no such case exists in the
    // 123-trace corpus, so the strict bar stands until one does.
    if (largestComment > 0 && bodyChars >= largestComment) {
      return fail(
        "body-discipline",
        `review body (${bodyChars}c) must be shorter than its largest inline comment (${largestComment}c) — a good review keeps the weight in the thread`,
      );
    }
    return pass("body-discipline", `body ${bodyChars}c < largest inline comment ${largestComment}c, within the discipline ceiling`);
  },
};

/**
 * Durable-token path pinning. Provenance: reuses the summary-policy normalization
 * (lowercase + collapse hyphen/whitespace runs — `normalizeForMention`). For
 * `completed` cases, every `mustPinPath` token must appear in at least one inline
 * comment's `path` (the finding is pinned to the right file). Tokens are durable
 * (a file path), not exact phrasings. No summary-mention needles on purpose — see
 * `ReviewerExpect`.
 */
export const reviewerMentionGrader: Grader<ReviewerExpect> = {
  name: "mentions",
  grade: ({ evalCase, result }) => {
    if (!result) {
      return fail("mentions", "no parseable result to inspect");
    }

    const pinned = evalCase.expect.mustPinPath ?? [];
    if (pinned.length > 0) {
      const paths = submitReviews(result).flatMap((submit) => submit.comments.map((comment) => normalizeForMention(comment.path)));
      for (const needle of pinned) {
        const wanted = normalizeForMention(needle);
        if (!paths.some((p) => p.includes(wanted))) {
          return fail("mentions", `expected an inline comment pinned to a path containing "${needle}" but found [${paths.join(", ") || "none"}]`);
        }
      }
    }

    return pass("mentions", "all expected paths pinned");
  },
};

/** Graders applied to each reviewer sample. All deterministic — no judge, no signals (analysis de-scopes both). */
export const reviewerGraders: Grader<ReviewerExpect>[] = [
  makeSchemaGrader<ReviewerExpect>(),
  reviewerOutcomeGrader,
  reviewMutationConformanceGrader,
  reviewerSummaryConcisenessGrader,
  reviewerBodyDisciplineGrader,
  reviewerMentionGrader,
];
