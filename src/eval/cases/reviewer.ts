import type { WorkerResult } from "../../domain/index.js";
import type { EvalCase } from "../types.js";
import { fileTask } from "./task-fixtures.js";

/**
 * The reviewer expectation payload (the `Expect` of its `EvalCase`s). Read only
 * by the reviewer graders in `../reviewer-graders.ts`.
 *
 * The reviewer eval grades a synthetic PR-review context (a `pr-review`
 * fixture), NOT an end-of-run reflection. Each case hands the reviewer the
 * complete, faithful result of the PR discovery it would otherwise run via `gh`,
 * then grades the emitted decision: a `no_action_needed` stand-down (concise
 * summary, zero mutations) or a `completed` review (exactly one COMMENT review
 * with inline threads, a disciplined body).
 */
export type ReviewerExpect = {
  /** The outcome the PR state warrants, checked by `reviewerOutcomeGrader`. */
  outcome: Extract<WorkerResult["outcome"], "no_action_needed" | "completed">;
  /**
   * For `completed` cases: durable tokens (e.g. the planted file path) that must
   * appear in at least one inline comment's `path`. Matching is case-insensitive
   * and hyphen/whitespace-tolerant (see `normalizeForMention`). No summary-mention
   * needles on purpose: real good stand-down summaries share no required phrasing
   * (the outcome field already carries the verdict), and a mention needle that
   * fails legitimate rephrasings is worse than none.
   */
  mustPinPath?: string[];
};

/**
 * Cases for the reviewer action (`prompts/templates/reviewer.md` +
 * `reviewer-continuation.md`). Each carries a `pr-review` fixture: a synthetic
 * PR-discovery context the reviewer reasons over directly (no network access).
 *
 * Sourcing (ENG-5444): grounded in the error analysis of 123 real reviewer
 * traces, `src/eval/analysis/reviewer-error-analysis.md`. The analysis found the
 * failure mass lives in exactly two prose modes — summary-overlong (continuation
 * stand-downs) and finding-in-body (first_pass completed) — never the review
 * judgement, and zero wrong-verdict exemplars. So the wrong-verdict / planted-bug
 * case is **SYNTHETIC** (the harvest carries PR metadata but not the diff, so a
 * missed-finding cannot be re-derived — analysis §"Corpus gaps"). Each case's
 * `description` cites its grounding: a real failure mode + exemplar attemptId, or
 * SYNTHETIC. Fixtures synthesize equivalents of the real PR shapes — no real PR
 * content is copied verbatim.
 */

// A plausible synthetic commit SHA shape (40-hex), used in fixtures so the
// reviewer sees realistic head/checkpoint references without any real PR.
const headSha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const followupSha = "b2c3d4e5f60718293a4b5c6d7e8f90123456789ab";

export const reviewerCases: EvalCase<ReviewerExpect>[] = [
  {
    // Grounded: summary-overlong continuation mode (analysis §1, 24/24 bad
    // continuation traces), exemplar 01KTT17P6AP8Q85AMCM803FYMF (788c re-narration
    // of an already-approved commit). Continuation pass with NOTHING new since the
    // checkpoint (same head SHA, no new comments, checks green) — the canonical
    // stand-down that must NOT balloon into a forensic re-verification.
    id: "continuation-nothing-new",
    description:
      "continuation, nothing new since checkpoint (same head, no new comments, checks green) → concise no_action_needed (grounded: summary-overlong mode, 01KTT17P6AP8Q85AMCM803FYMF)",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-R001",
      "Review: surcharge bracket rounding fix on shipping-service",
      "Continuation reviewer pass on the open PR fixing surcharge-bracket rounding.",
      "high",
    ),
    fixture: {
      type: "pr-review",
      continuation: true,
      pullRequestReference: {
        provider: "github",
        url: "https://github.com/invenco/shipping/pull/1142",
        number: 1142,
        state: "open",
        isDraft: false,
        headSha,
        headBranch: "eng-5301-surcharge-rounding",
        baseBranch: "master",
        headIntroducedAt: "2026-06-09T14:02:00Z",
        mergeState: "clean",
      },
      priorCheckpoint: {
        priorPassSummary: "Reviewed the surcharge-bracket rounding fix; one thread raised on the boundary case, otherwise clean.",
        headSha,
        latestReviewSummaryId: null,
        latestConversationCommentId: "IC_kwDOabc1",
        reviewThreadsFingerprint: "rt:8f21",
        checksFingerprint: "ck:green:lint,typecheck,unit",
        mergeState: "clean",
        recordedAt: "2026-06-09T15:10:00Z",
      },
      discovery: [
        "## Commits since checkpoint",
        "",
        "None. The PR head is still `" + headSha + "` (`eng-5301-surcharge-rounding`), unchanged since the prior reviewer checkpoint at 2026-06-09T15:10:00Z.",
        "",
        "## Diff since checkpoint",
        "",
        "Empty — no new commits, so no new diff to review.",
        "",
        "## Review threads",
        "",
        "One existing thread (raised by the prior reviewer pass) on the bracket-boundary case in `src/modules/surcharge/domain/SurchargeBracket.ts`. Status: unresolved, no new replies since the checkpoint.",
        "",
        "## Conversation comments",
        "",
        "No new conversation comments since the checkpoint (latest is `IC_kwDOabc1`, already seen).",
        "",
        "## Checks",
        "",
        "All green: lint, typecheck, unit (123 passed). Same as the checkpoint's `ck:green` fingerprint. Two manual approval gates remain pending (deploy-DEV, deploy-STAGING) — manual, not agent-actionable.",
        "",
        "## Merge state",
        "",
        "MERGEABLE / clean.",
      ].join("\n"),
    },
    expect: {
      outcome: "no_action_needed",
    },
  },
  {
    // Grounded: the dominant good-continuation pattern (analysis §"Overall", 50
    // good continuation traces). One new commit addresses a prior review nit,
    // checks green, diff trivially clean → concise stand-down. The continuation
    // template now carries summary-policy (committed template fix), so the
    // conciseness contract is in force on this pass.
    id: "continuation-clean-followup-commit",
    description:
      "continuation, one new commit addresses a review nit, checks green, diff clean → concise no_action_needed (grounded: dominant good-continuation pattern, 50 good traces)",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-R002",
      "Review: carrier-rate cache key normalization",
      "Continuation reviewer pass on the open PR normalizing the carrier-rate cache key.",
      "high",
    ),
    fixture: {
      type: "pr-review",
      continuation: true,
      pullRequestReference: {
        provider: "github",
        url: "https://github.com/invenco/shipping/pull/1156",
        number: 1156,
        state: "open",
        isDraft: false,
        headSha: followupSha,
        headBranch: "eng-5318-cache-key-normalization",
        baseBranch: "master",
        headIntroducedAt: "2026-06-10T09:40:00Z",
        mergeState: "clean",
      },
      priorCheckpoint: {
        priorPassSummary: "Reviewed the cache-key normalization; flagged a thread asking to trim whitespace before lowercasing the carrier code.",
        headSha,
        latestReviewSummaryId: null,
        latestConversationCommentId: "IC_kwDOdef2",
        reviewThreadsFingerprint: "rt:5b03",
        checksFingerprint: "ck:green:lint,typecheck,unit",
        mergeState: "clean",
        recordedAt: "2026-06-10T08:55:00Z",
      },
      discovery: [
        "## Commits since checkpoint",
        "",
        "One new commit `" + followupSha + "`: \"ENG-5318: trim before lowercasing the carrier code\" — the maintainer's response to the prior reviewer thread.",
        "",
        "## Diff since checkpoint",
        "",
        "```diff",
        "--- a/src/modules/carrierRate/appServices/normalizeCacheKey.ts",
        "+++ b/src/modules/carrierRate/appServices/normalizeCacheKey.ts",
        "@@",
        "-  return `${carrierCode.toLowerCase()}:${serviceCode.toLowerCase()}`;",
        "+  return `${carrierCode.trim().toLowerCase()}:${serviceCode.trim().toLowerCase()}`;",
        "```",
        "",
        "Exactly the change the prior thread requested — trims both codes before lowercasing.",
        "",
        "## Review threads",
        "",
        "The prior thread on `normalizeCacheKey.ts` is now addressed by the new commit; the maintainer left a reply: \"trimmed both, good catch\". No new threads.",
        "",
        "## Conversation comments",
        "",
        "No new conversation comments beyond the thread reply.",
        "",
        "## Checks",
        "",
        "All green on the new head: lint, typecheck, unit (98 passed, including the existing cache-key tests).",
        "",
        "## Merge state",
        "",
        "MERGEABLE / clean.",
      ].join("\n"),
    },
    expect: {
      outcome: "no_action_needed",
    },
  },
  {
    // Grounded: 21 real first_pass no_action traces (analysis §"no_action summary
    // length", first_pass max 363c with summary-policy in force). First pass on a
    // small clean diff, checks green → concise stand-down. The positive baseline
    // for the first_pass conciseness bar.
    id: "first-pass-clean-pr",
    description:
      "first pass, small clean diff, checks green → concise no_action_needed (grounded: 21 first_pass no_action traces, max 363c)",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-R003",
      "Review: add a readonly getter for the deploy gate",
      "First reviewer pass on the open PR adding a readonly deploy-gate getter.",
      "high",
    ),
    fixture: {
      type: "pr-review",
      pullRequestReference: {
        provider: "github",
        url: "https://github.com/invenco/foreman/pull/214",
        number: 214,
        state: "open",
        isDraft: false,
        headSha,
        headBranch: "eng-5402-deploy-gate-getter",
        baseBranch: "master",
        headIntroducedAt: "2026-06-11T11:20:00Z",
        mergeState: "clean",
      },
      discovery: [
        "## Commits",
        "",
        "One commit `" + headSha + "`: \"ENG-5402: expose a readonly deployGate getter\".",
        "",
        "## Diff",
        "",
        "```diff",
        "--- a/src/orchestration/deploy-gate.ts",
        "+++ b/src/orchestration/deploy-gate.ts",
        "@@ class DeployGate {",
        "   private readonly state: DeployGateState;",
        "+",
        "+  get isOpen(): boolean {",
        "+    return this.state.phase === \"open\";",
        "+  }",
        " }",
        "```",
        "",
        "A pure-readonly accessor over the existing `state.phase` field. No mutation, no new branch, no error path.",
        "",
        "## Review threads",
        "",
        "None — first pass on this PR.",
        "",
        "## Conversation comments",
        "",
        "None.",
        "",
        "## Checks",
        "",
        "All green: lint, typecheck, unit (added one test asserting `isOpen` reflects `phase`).",
        "",
        "## Merge state",
        "",
        "MERGEABLE / clean.",
      ].join("\n"),
    },
    expect: {
      outcome: "no_action_needed",
    },
  },
  {
    // SYNTHETIC — the analysis found ZERO real wrong-verdict / missed-finding
    // exemplars (§"Corpus gaps": the harvest carries PR metadata but not the diff,
    // so a missed finding cannot be re-derived; any should-have-raised case must be
    // synthetic). This plants one OBJECTIVELY WRONG bug — a Result error path that
    // silently swallows the sad branch and returns ok — and asserts the reviewer
    // raises a thread rather than standing down. Not stylistic: the function
    // discards the failure and reports success.
    id: "first-pass-planted-bug",
    description:
      "SYNTHETIC (zero real wrong-verdict exemplars): first pass, diff contains a planted Result error-swallow bug → completed with one COMMENT review pinning an inline thread to the bug",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-R004",
      "Review: persist the carrier-rate cache entry",
      "First reviewer pass on the open PR adding cache persistence for carrier rates.",
      "high",
    ),
    fixture: {
      type: "pr-review",
      pullRequestReference: {
        provider: "github",
        url: "https://github.com/invenco/shipping/pull/1171",
        number: 1171,
        state: "open",
        isDraft: false,
        headSha,
        headBranch: "eng-5410-persist-cache-entry",
        baseBranch: "master",
        headIntroducedAt: "2026-06-11T16:05:00Z",
        mergeState: "clean",
      },
      discovery: [
        "## Commits",
        "",
        "One commit `" + headSha + "`: \"ENG-5410: persist the carrier-rate cache entry after a rate lookup\".",
        "",
        "## Diff",
        "",
        "```diff",
        "--- a/src/modules/carrierRate/appServices/persistCacheEntry.ts",
        "+++ b/src/modules/carrierRate/appServices/persistCacheEntry.ts",
        "@@",
        "+export const persistCacheEntry = async (",
        "+  repo: CarrierRateCacheRepo,",
        "+  entry: CarrierRateCacheEntry,",
        "+): Promise<Result<void, PersistError>> => {",
        "+  const saved = await repo.upsert(entry);",
        "+  if (saved.isErr()) {",
        "+    // swallow: best-effort cache write",
        "+  }",
        "+  return ok(undefined);",
        "+};",
        "```",
        "",
        "The repo `upsert` returns a `Result`. When it returns the sad branch (`saved.isErr()`), the function discards the error and still returns `ok(undefined)` — the caller is told the persist succeeded even when it failed. The comment calls it 'best-effort', but the function's signature promises `Result<void, PersistError>`, so a real failure is silently converted to success and the typed error path is dead.",
        "",
        "## Review threads",
        "",
        "None — first pass on this PR.",
        "",
        "## Conversation comments",
        "",
        "None.",
        "",
        "## Checks",
        "",
        "All green: lint, typecheck, unit. (No test exercises the upsert-failure branch.)",
        "",
        "## Merge state",
        "",
        "MERGEABLE / clean.",
      ].join("\n"),
    },
    expect: {
      outcome: "completed",
      mustPinPath: ["src/modules/carrierRate/appServices/persistCacheEntry.ts"],
    },
  },
  {
    // Grounded: finding-in-body mode (analysis §2, 3 real bads ≥1038c:
    // 01KRJ8Q45N0RFQ606WR0ZNFF56, 01KRG9P5WFAN8CN6X01CHP987V,
    // 01KR0SMX2NMQTPB9EA22PRPP79; good bodies max 682c, good inline threads median
    // 962c). A real-but-modest issue designed to tempt body-dumping: the diff has
    // one genuine finding worth a thread, and the reviewer must keep the detail IN
    // the thread, not duplicate it into the top-level body.
    id: "first-pass-findings-stay-in-threads",
    description:
      "first pass, one real modest issue that tempts body-dumping → completed with the finding detail in the inline thread, not the body (grounded: finding-in-body mode, 01KRJ8Q45N0RFQ606WR0ZNFF56 / 01KRG9P5WFAN8CN6X01CHP987V / 01KR0SMX2NMQTPB9EA22PRPP79)",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-R005",
      "Review: paginate the attempts list query",
      "First reviewer pass on the open PR paginating the attempts-list query.",
      "high",
    ),
    fixture: {
      type: "pr-review",
      pullRequestReference: {
        provider: "github",
        url: "https://github.com/invenco/foreman/pull/231",
        number: 231,
        state: "open",
        isDraft: false,
        headSha,
        headBranch: "eng-5421-paginate-attempts",
        baseBranch: "master",
        headIntroducedAt: "2026-06-11T17:30:00Z",
        mergeState: "clean",
      },
      discovery: [
        "## Commits",
        "",
        "One commit `" + headSha + "`: \"ENG-5421: paginate the attempts-list query\".",
        "",
        "## Diff",
        "",
        "```diff",
        "--- a/src/repos/attempts-repo.ts",
        "+++ b/src/repos/attempts-repo.ts",
        "@@",
        "-  listAttempts(taskId: string): Attempt[] {",
        "-    return this.db.prepare(\"SELECT * FROM attempts WHERE task_id = ?\").all(taskId);",
        "+  listAttempts(taskId: string, limit: number, offset: number): Attempt[] {",
        "+    return this.db",
        "+      .prepare(\"SELECT * FROM attempts WHERE task_id = ? LIMIT ? OFFSET ?\")",
        "+      .all(taskId, limit, offset);",
        "   }",
        "```",
        "",
        "The query now takes `limit`/`offset` but adds no `ORDER BY`. Without a stable ordering, SQLite's row order is unspecified across pages, so pagination can repeat or skip rows between calls. A genuine, modest correctness finding worth one thread pinned to the changed query line — the fix is to add a deterministic `ORDER BY` (e.g. `created_at, id`).",
        "",
        "## Review threads",
        "",
        "None — first pass on this PR.",
        "",
        "## Conversation comments",
        "",
        "None.",
        "",
        "## Checks",
        "",
        "All green: lint, typecheck, unit (a test asserts the first page's length but not cross-page stability).",
        "",
        "## Merge state",
        "",
        "MERGEABLE / clean.",
      ].join("\n"),
    },
    expect: {
      outcome: "completed",
      mustPinPath: ["src/repos/attempts-repo.ts"],
    },
  },
];
