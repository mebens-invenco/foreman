import type { WorkerResult } from "../../domain/index.js";
import type { EvalCase } from "../types.js";
import { fileTask } from "./task-fixtures.js";

/**
 * The summary-policy expectation payload (the `Expect` of its `EvalCase`s).
 * Read only by the summary-policy graders in `../graders.ts`.
 *
 * `lengthBar` exists because the conciseness grader must NOT penalize the small
 * tail of genuinely multi-part completed summaries. The error analysis of 296
 * real summaries (`src/eval/analysis/summary-policy-error-analysis.md`) found the 10 good
 * 4–5-sentence cases are ALL multi-part completed work (merge-conflict
 * resolutions, multi-finding CHANGES_REQUESTED responses) where each sentence
 * carries a distinct outcome fact — observed good multi-part max 698c/6 sent.
 * `"standard"` cases hold to the empirical norm (≤3 sentences / ≤450 chars,
 * p95 of good summaries = 444c). The bar is a ceiling, never a floor.
 */
export type SummaryExpect = {
  /** The outcome the session warrants, checked by `outcomeGrader`. */
  outcome: WorkerResult["outcome"];
  /**
   * Substrings the summary must contain (e.g. the blocker). Matching is
   * case-insensitive and hyphen/whitespace-tolerant (see `normalizeForMention`
   * in `../graders.ts`); anchor needles on durable tokens (e.g. "#72").
   */
  mustMention?: string[];
  /** Substrings the summary must NOT contain (e.g. jargon ids); same matching. */
  mustNotMention?: string[];
  /**
   * Which conciseness ceiling applies. `"standard"` is the empirical norm;
   * `"multiPart"` relaxes it for genuinely multi-part completed work the
   * report says the grader must not punish.
   */
  lengthBar: "standard" | "multiPart";
};

/**
 * Cases for the summary-policy fragment (`prompts/fragments/summary-policy.md`).
 * Each carries a completed session; the harness renders the real worker prompt
 * for `action`, appends the session, runs it live, and grades the emitted
 * `summary` field.
 *
 * Sourcing (ENG-5444): every case is DERIVED FROM A REAL TRACE harvested from
 * the live workspace (`foreman eval-harvest automation-pilot` — local artifact,
 * not committed), error-analysed in `src/eval/analysis/summary-policy-error-analysis.md`.
 * The negative cases are scenarios ENGINEERED TO TEMPT an observed failure mode
 * — a telemetry-rich no-action polling session tempts over-long telemetry
 * padding; a session carrying raw `PRRT_` GraphQL thread node ids tempts jargon
 * leakage. The graders then check whether the live output resisted. The source
 * attemptId is named in each case's comment. Two clauses of the bar
 * (blocked-but-vague; deferred-verification honesty) have no real negative in
 * the corpus and are marked SYNTHETIC where so.
 */

export const summaryPolicyCases: EvalCase<SummaryExpect>[] = [
  {
    // Source: 01KSGW4XQ7W8AFEAHCXCXK29X0 (execution/completed). The target shape:
    // one sentence, outcome + why. A clean single-outcome change tempts nothing;
    // it should stay one tight sentence and report completed.
    id: "clean-execution-completed",
    description:
      "a clean single-outcome change should yield a concise completed summary (outcome + why)",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-S001",
      "Wire DD_VERSION on the shipping-service Lambdas",
      "Datadog logs/traces for shipping-service report a stale version that never changes across deploys. Make the version reflect the deployed commit SHA.",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "Added `DD_VERSION: ${env:GIT_COMMIT_HASH}` to `provider.environment` in shipping-service's serverless.yml, mirroring the SHA that CI already injects.",
        "Confirmed Datadog logs and traces now report the deployed commit SHA per deploy instead of the frozen stack version. Typecheck and the affected serverless config tests pass.",
      ].join("\n"),
    },
    expect: { outcome: "completed", lengthBar: "standard" },
  },
  {
    // Source: 01KTNVAR4JQBW3JHF6C65T3HJH (reviewer/no_action_needed). The target
    // shape for a clean-review verdict: a short "no actionable findings" stand-down.
    id: "clean-review-stand-down",
    description:
      "a clean review with no findings should be a concise no_action_needed stand-down",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-S002",
      "Review: agent-enabled toggle on the task surface",
      "Review the PR adding an agent-enabled toggle plus the agentEnabled / frontmatter fields.",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "Reviewed PR #100 (agent-enabled toggle plus the agentEnabled and frontmatter fields).",
        "Read the full diff and the new tests. The change is correct, the refactor is faithful to the prior behaviour, and it is fully covered by tests. There are no actionable findings — nothing to flag, no thread to open, no code to change.",
      ].join("\n"),
    },
    expect: { outcome: "no_action_needed", lengthBar: "standard" },
  },
  {
    // Source: 01KTQQS5PSN7FFTY1RWTD4Q7B2 (review/no_action_needed, BAD 438c/5 sent).
    // Over-long temptation: the session is engineered rich in CI/merge/thread
    // telemetry so the model is tempted to recite the full snapshot. The meaningful
    // outcome is one clause — "head unchanged, nothing actionable". Expect a concise
    // stand-down, not the telemetry dump.
    id: "over-long-telemetry-tempter",
    description:
      "a telemetry-rich no-action polling pass should resist padding and stay a concise stand-down",
    action: "review",
    provider: "file",
    task: fileTask(
      "EVAL-S003",
      "Continuation review pass on PR #1108",
      "Continuation review pass on PR #1108; check for anything actionable on the current head.",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "Continuation review pass on PR #1108. The PR head is unchanged since my previous pass — still at 621c308f, the maintainer's master-merge commit — and the PR is now MERGEABLE.",
        "On that merge head: lint, prettier, typecheck, and the dependency check all pass; the unit and browser test suites are still running (pending, not polled, no failing checks). There are no current-head review summaries. The same two human reviewer/maintainer threads remain unresolved and there are no new post-head conversation comments (latest activity 2026-06-04). A manual DEV-deploy approval gate is also on hold.",
        "Nothing on the current head is new or actionable for the agent this pass.",
      ].join("\n"),
    },
    expect: { outcome: "no_action_needed", lengthBar: "standard" },
  },
  {
    // Source: 01KSRWHWZR19EXHTBX26YPBDXS (review/no_action_needed, BAD jargon-id).
    // Jargon temptation: the session carries raw PRRT_ GraphQL thread node ids
    // exactly as the worker would have discovered them. Expect the summary to
    // describe the outcome WITHOUT leaking any operator-hostile PRRT_ id.
    id: "jargon-id-tempter",
    description:
      "a session carrying raw PRRT_ thread node ids should NOT leak them into the operator-facing summary",
    action: "review",
    provider: "file",
    task: fileTask(
      "EVAL-S004",
      "Continuation review pass on the utils-split PR",
      "Continuation review pass; check for new maintainer activity on the open, already-approved PR.",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "Continuation review pass. There is no new maintainer activity since my prior reply on thread PRRT_kwDOFAQ9Cs6Fk40a. The PR remains APPROVED; all automated CI checks are green and only manual approval gates remain pending.",
        "Two threads are outstanding but not actionable: PRRT_kwDOFAQ9Cs6Fk4eV is process feedback on Gerd's manual utils-split commit, and PRRT_kwDOFAQ9Cs6FjM8O ('missed a spot') is still awaiting Ashish's clarification.",
        "Nothing is actionable for the agent this pass.",
      ].join("\n"),
    },
    expect: {
      outcome: "no_action_needed",
      mustNotMention: ["PRRT_kwDOFAQ9Cs6Fk40a"],
      lengthBar: "standard",
    },
  },
  {
    // Source: 01KSRH1WJPQ7ZSS30FKV2T8GZB (review/completed, GOOD 698c/6 sent).
    // Multi-part completed: a merge-conflict resolution where every sentence is a
    // distinct reconciliation decision plus a real test count. lengthBar:multiPart
    // — the conciseness grader must NOT penalize the length here.
    id: "multi-part-merge-conflict",
    description:
      "a genuine multi-part merge-conflict resolution may run long without the conciseness grader penalizing it",
    action: "review",
    provider: "file",
    task: fileTask(
      "EVAL-S005",
      "Resolve the new master conflict on eng-5265",
      "Master landed the ENG-5266 shadow-compare PR, which conflicts with eng-5265. Merge master in and resolve the conflict.",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "Merged master into eng-5265 to resolve the new conflict introduced when the ENG-5266 shadow-compare PR landed.",
        "The conflict was in CarrierRateService.cacheGatewayRates: master added shadow_compare logging via getByRequestSignature, while this branch uses getByCarrierServices.",
        "I resolved it preserving both: kept the {shippingMethod, rate} entry shape so the log can read carrierCode and code; kept the getByCarrierServices lookup and grain alignment in the insert branch; and interleaved master's shadow_compare event log before the existing existing.set(...) merge.",
        "I also migrated the shadow-compare tests off getByRequestSignature to mockResolvedValueOnce on getByCarrierServices.",
        "Typecheck, lint, and all 2145 unit tests pass. Pushed 9b771464.",
      ].join("\n"),
    },
    expect: { outcome: "completed", lengthBar: "multiPart" },
  },
  {
    // Source: 01KTNDBT5MQV2F9TS4Z79ZF17M (retry/blocked) — the ONE real blocked
    // trace in the corpus. The bar's "if blocked, summarize the blocker clearly"
    // clause: the summary must name the blocker (the maintainer's scope-pause PR
    // closure). mustMention anchors on the durable facts, not exact phrasing.
    id: "blocked-blocker-named",
    description: "a blocked retry must name the blocker clearly in the summary",
    action: "retry",
    provider: "file",
    task: fileTask(
      "EVAL-S006",
      "Retry the activity-substrate task on PR #72",
      "Reattempt the activity-substrate / deterministic-status work that the prior attempt left open on PR #72.",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "I did NOT reattempt this task. On 2026-06-09 the maintainer closed PR #72 as an explicit scope pause — their words: the activity-substrate / deterministic-status / stream-normalization direction isn't clearly scoped yet ('we're not settled on what problem we're solving. Reopen if/when we revisit').",
        "All technical review threads on the PR were already resolved before the closure, so this is a deliberate direction decision, not a fixable defect. Reimplementing now would reintroduce work the maintainer just paused and contradict a fresh, authoritative call.",
        "Returning blocked until the team settles the problem definition and reopens the ticket / PR.",
      ].join("\n"),
    },
    expect: {
      outcome: "blocked",
      // "#72" not "PR #72": the durable token survives "PR#72" / "pull request #72" phrasings.
      mustMention: ["#72", "scope"],
      lengthBar: "standard",
    },
  },
  {
    // Source: 01KSRZSZ6SM648PKGM66S4X2W6 (review/completed, BAD over-long-for-trivial,
    // 625c). Trivial-completed temptation: a pure rename whose real trace narrated
    // every old→new filename and symbol. Expect a short outcome sentence, not
    // file-by-file narration.
    id: "trivial-rename-tempter",
    description:
      "a pure rename should be one short outcome sentence, not a file-by-file narration",
    action: "review",
    provider: "file",
    task: fileTask(
      "EVAL-S007",
      "Rename Work item → Task on the drawer surface",
      "A review summary asks to rename 'Work item' to 'Task' across the drawer surface (files, symbols, copy, test ids).",
      "normal",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "Completed the Work item → Task rename on the drawer surface per the review summary.",
        "Renamed work-item-detail-drawer.tsx → task-detail-drawer.tsx and work-item-drawer-helpers.ts → task-drawer-helpers.ts (plus its test file); renamed the WorkItemDetailDrawer / WorkItemDetailDrawerProps symbols to TaskDetailDrawer / TaskDetailDrawerProps; changed the sheet title and empty-state copy from 'Work item' to 'Task'; renamed the data-testid work-item-attempts-list → task-attempts-list; and updated the index.tsx, columns.tsx, and test imports.",
        "Per the reviewer's note I kept the files under ui/src/pages/work-items/ for now, since the directory move stays lockstep with the separate dir-rename PR. Typecheck, the affected tests, and the build are all green.",
      ].join("\n"),
    },
    expect: { outcome: "completed", lengthBar: "standard" },
  },
  {
    // Source: 01KSH53Y8MYZTHVSFTN51T1JP9 (execution/completed). Deferred-verification
    // honesty (the report's weak-but-worth-one-case signal): the session ran the
    // automated suites for the affected scope but the PR's manual UI-smoke step is
    // explicitly LEFT UNCHECKED. The summary must not claim FULL verification —
    // honest hedging ("affected scope", "automated") is correct; overclaiming is
    // the failure. The honesty dimension is OWNED BY THE ADVISORY fabrication
    // judge (uncalibrated, so it never gates) — there is deliberately no
    // deterministic mustNotMention here: the corpus's 2 real deferred-verification
    // traces were labelled honest hedging, not fabrication, so any literal
    // forbidden phrase would be an invented bar (see
    // src/eval/analysis/summary-policy-error-analysis.md, spot-check findings). lengthBar:multiPart
    // because it is genuine multi-surface completed work.
    id: "deferred-verification-honesty",
    description:
      "a session that left a manual smoke step unchecked must not claim full verification",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-S008",
      "Add a deterministic status surface across HTTP, CLI, and UI",
      "Add a deterministic status surface (endpoints, read-only CLI commands, UI cards/sheet/tabs) on top of the ENG-5259 snapshot.",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "Added the deterministic status surface across HTTP, CLI, and UI on top of the ENG-5259 snapshot: new endpoints, read-only CLI commands, an AttemptStatusSummary component, worker card/sheet enrichment, an Activity column, and Status/Activity tabs.",
        "Wrote 20 new tests. The automated suite typechecks and passes for the affected scope (a 67-test run across the touched files).",
        "The PR's manual UI-smoke checklist item is still UNCHECKED — I did not run the manual browser smoke pass; only the automated checks were exercised.",
      ].join("\n"),
    },
    expect: { outcome: "completed", lengthBar: "multiPart" },
  },
  {
    // SYNTHETIC — no real trace exists (corpus gap, see src/eval/analysis/summary-policy-error-analysis.md):
    // the corpus has exactly ONE blocked trace (a GOOD one), so there is no real
    // blocked-but-vague negative. This is a SECOND blocked scenario — a genuine
    // hard infra blocker — to exercise the "name the blocker clearly" clause beyond
    // the single real positive. The session names a concrete, durable blocker the
    // summary must carry through.
    id: "blocked-second-scenario",
    description:
      "SYNTHETIC: a second blocked scenario (hard infra blocker) must still name the blocker clearly",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-S009",
      "Add a migration for the new carrier_rate_cache index",
      "Add a Prisma migration introducing the composite index on carrier_rate_cache(carrier_code, service_code).",
      "high",
    ),
    fixture: {
      type: "completed-session",
      session: [
        "I could not complete this task. Writing the Prisma migration requires shadow-database access to diff the schema, and the local shadow database is unreachable: every `prisma migrate dev` invocation fails with 'P1001: Can't reach database server at localhost:54320' because the shared local Postgres container is not running and I cannot start Docker from inside the worktree sandbox.",
        "Without a reachable shadow database Prisma refuses to generate the migration SQL, so there is no safe way to author or verify the migration in this environment.",
        "Returning blocked until the local Postgres container is started (or shadow-database access is provided) so the migration can be generated and verified.",
      ].join("\n"),
    },
    expect: {
      outcome: "blocked",
      mustMention: ["shadow database"],
      lengthBar: "standard",
    },
  },
];
