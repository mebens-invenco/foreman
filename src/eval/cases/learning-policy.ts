import type { Task } from "../../domain/index.js";
import type { EvalCase } from "../types.js";

/**
 * The learning-policy expectation payload (the `Expect` of its `EvalCase`s).
 * Read only by the learning-policy graders in `../graders.ts`.
 */
export type LearningExpect = {
  /** What the end-of-run learning review should do for this session. */
  decision: "learning" | "no_learning";
  /**
   * Optional repo-scope expectation for an emitted learning, checked by the
   * advisory `scopeGrader`: "shared" when the insight is clearly cross-repo,
   * "repo-specific" when it is local to one repo. Omit when no learning is
   * expected, or when scope is not the dimension under test.
   */
  scope?: "shared" | "repo-specific";
};

/**
 * Cases for the learning-policy write-back. Each carries a completed session;
 * the harness renders the real worker prompt for `action`, appends the session,
 * runs it live, and grades whether the end-of-run learning review does the right
 * thing.
 *
 * The first two cases are hand-authored. The rest (ENG-5342) are seeded from real
 * automation-pilot worker traces: each scenario, expected decision, and expected
 * scope reflects an observed run, error-analysed against the ratified reusability
 * bar (non-obvious + reusable + helps a future, different task; decline routine /
 * obvious / one-off / too-specific). Synthetic cases remain only to fill gaps.
 *
 * Still NOT exercised: the Search/dedup step and `update` mutations. Those need a
 * seeded learnings store — 0/244 live prompts inject existing learnings (the
 * worker searches at runtime), so a stateless run starts empty. Deferred to the
 * seeded-store increment; the dedup behaviour is documented from real traces.
 */

const fileTask = (id: string, title: string, description: string, priority: Task["priority"]): Task => ({
  id,
  provider: "file",
  providerId: id,
  title,
  description,
  state: "ready",
  providerState: "ready",
  priority,
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: "eval-repo", branchName: id.toLowerCase(), position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-06-01T00:00:00Z",
  url: null,
});

export const learningPolicyCases: EvalCase<LearningExpect>[] = [
  {
    id: "reusable-insight",
    description: "a session that surfaced a non-obvious, reusable pattern should produce a well-formed learning",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-0001",
      "Add retry with backoff to the Linear bulk-sync job",
      "The nightly Linear bulk-sync intermittently fails. Make it resilient to transient API throttling.",
      "high",
    ),
    syntheticSession: [
      "Added exponential backoff to the bulk-sync client and verified it against a replayed throttle window.",
      "The root cause was non-obvious: Linear's GraphQL API returns HTTP 200 with a top-level `errors[]` entry whose code is `RATELIMITED` when the query-complexity budget is exceeded — it does NOT return a 429. The existing retry logic keyed off HTTP status, so it never fired and the job just failed.",
      "The fix keys retries off the `RATELIMITED` error code in the GraphQL body and backs off using the window in `extensions`. This applies to every Linear GraphQL caller in the codebase, not just bulk-sync.",
    ].join("\n"),
    expect: { decision: "learning" },
  },
  {
    id: "routine-no-learning",
    description: "a trivial, one-off session should record no learning (empty learningMutations is the correct decision)",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-0002",
      "Fix typo in the dashboard header",
      "The dashboard header reads 'Overivew'. Correct the spelling.",
      "low",
    ),
    syntheticSession: [
      "Changed the string 'Overivew' to 'Overview' in DashboardHeader.tsx. One-line copy fix, no logic change.",
      "Existing tests pass unchanged. Nothing here generalises beyond this exact string.",
    ].join("\n"),
    expect: { decision: "no_learning" },
  },

  // --- Real-trace-seeded cases (ENG-5342, from automation-pilot worker traces) ---

  {
    id: "reusable-insight-env-config",
    description: "a non-obvious, cross-repo infra mechanism should be recorded as a shared learning",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-0003",
      "Wire the service for Datadog observability",
      "Datadog logs/traces for this Lambda service show a stale `version` that never changes across deploys. Make the version reflect the deployed commit.",
      "high",
    ),
    syntheticSession: [
      "Fixed the frozen Datadog `version`. The root cause was non-obvious: Datadog sources the `version` field on logs and traces from the `DD_VERSION` environment variable on the Lambda — NOT from the CloudFormation stack's `tags.version` (which only flows to AWS billing/resource tags).",
      "Added `DD_VERSION: ${env:GIT_COMMIT_HASH}` to `provider.environment` in serverless.yml, mirroring the value CI injects, and verified the version now refreshes per deploy.",
      "This is the same mechanism for every Lynk Lambda service that ships the Datadog extension — not just this one. Anyone debugging a stale Datadog version on any service hits it.",
    ].join("\n"),
    expect: { decision: "learning", scope: "shared" },
  },
  {
    id: "reusable-insight-ui-pitfall",
    description: "a non-obvious, recurring library pitfall found in review should be a repo-specific learning",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-0004",
      "Review: add an 'All services' filter dropdown",
      "Review the PR adding an 'All services' option to the carrier-service Select on the accounts page.",
      "high",
    ),
    syntheticSession: [
      "Reviewed the PR. The new 'All' option was coded as `<SelectItem value=''>All</SelectItem>`. In this app's shadcn/radix Select an empty-string item value is forbidden — radix throws at runtime ('A <Select.Item /> must have a value prop that is not an empty string'), because empty string is reserved for the cleared/placeholder state.",
      "Flagged it: define a sentinel constant (e.g. `ALL_SERVICES_VALUE = 'all-services'`), use it as the item value, and map it back to null on submit.",
      "This recurs throughout this frontend repo because it is mid Ant-Design -> shadcn migration; any author or reviewer touching a shadcn Select with an all/none option will hit it.",
    ].join("\n"),
    expect: { decision: "learning", scope: "repo-specific" },
  },
  {
    id: "routine-decline-mechanical",
    description: "a purely mechanical, already-repeated migration should record no learning",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-0005",
      "Migrate e2e imports to the new interface package",
      "Update the e2e test files to import from `@invenco/automation-interface` instead of the old `@invenco/common-interface/automation` path.",
      "low",
    ),
    syntheticSession: [
      "Migrated 6 e2e test files from `@invenco/common-interface/automation` to the new `@invenco/automation-interface` package. Pure find-and-replace of the import path; no logic changed.",
      "Ran lint, typecheck, and prettier — all clean. This is the same mechanical move already done across several sibling PRs; nothing here is non-obvious or transferable beyond following the established migration.",
    ].join("\n"),
    expect: { decision: "no_learning" },
  },
  {
    id: "routine-decline-review-noop",
    description: "an idempotent review re-check with no new state should record no learning",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-0006",
      "Review: import-path migration PR",
      "Re-review the open PR migrating import paths; check for anything actionable on the current head.",
      "low",
    ),
    syntheticSession: [
      "Re-reviewed the PR. The head SHA is unchanged since my previous reviewer pass. The one prior review thread (a tsconfig include) is already resolved and outdated. CI is green. There are no new commits and no new conversation comments.",
      "Nothing new to react to — no_action_needed. A routine re-check that found no change since last time.",
    ].join("\n"),
    expect: { decision: "no_learning" },
  },
  {
    id: "over-eager-hyperspecific",
    description: "an insight too specific to one component's layout should NOT be recorded (resist over-eager capture)",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-0007",
      "Review: per-bracket editor cards on the account detail page",
      "Review the account detail page that renders one editor card per weight-bracket, each saving independently.",
      "high",
    ),
    syntheticSession: [
      "Reviewed the detail page that renders one editor card per weight-bracket. Confirmed that when one card saves and invalidates the shared query, the other cards' in-progress unsaved edits survive — but only because React Query's default `structuralSharing: true` keeps unchanged items' object references stable, so their `useEffect([config])` re-seed effect doesn't fire.",
      "Verified this exact behaviour holds for this page's specific card layout and query-invalidation wiring. It is a precise property of how these particular cards are composed; there's no general rule here beyond this one page's arrangement.",
    ].join("\n"),
    expect: { decision: "no_learning" },
  },
  {
    id: "multi-learning-orchestrator-review",
    description: "a session surfacing two distinct reusable review rules should record both, each well-formed",
    action: "reviewer",
    provider: "file",
    task: fileTask(
      "EVAL-0008",
      "Review: harden startup validation in the orchestrator",
      "Review the PR that makes the orchestrator's startup validation throw on a configured-value miss.",
      "high",
    ),
    syntheticSession: [
      "Reviewed the orchestrator PR. Two distinct, non-obvious lessons came up:",
      "(1) This orchestrator surfaces failures by throwing a typed error by design — it is not a Lynk DDD domain service, so the Lynk Result<Happy,Sad> / never-throw guardrail does NOT apply here. I almost flagged the `throw` as a Result-discipline violation; that would have been wrong — the throw is intentional fail-loud, validated eagerly at startup.",
      "(2) The worktree's local `master` ref lagged the PR's actual base by 100+ commits, so `git diff master...HEAD` showed a huge phantom diff. The real review diff has to come from `gh pr diff` (or against origin's base), or a reviewer wastes the pass on unrelated code.",
      "Both recur on any review pass of this repo.",
    ].join("\n"),
    expect: { decision: "learning", scope: "repo-specific" },
  },
  {
    id: "ambiguous-repo-quirk",
    description: "borderline: one repo's config quirk (repo-specific-recurring vs too-one-off). Strict bar -> decline; pass-rate is the signal",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-0009",
      "Add a runbook under docs/runbooks/",
      "Add a new operational runbook markdown file under `docs/runbooks/` in this service.",
      "low",
    ),
    syntheticSession: [
      "Added a runbook at `docs/runbooks/incident-x.md`. git silently ignored it — `git add` reported nothing untracked. The repo's `.gitignore` has `docs/*` followed by `!docs/*.md`, and that negation only matches top-level `.md` files, so any `docs/` subdirectory stays ignored.",
      "Worked around it by placing the file flat under `docs/`. `git check-ignore -v` confirmed the original path matched the `docs/*` rule.",
    ].join("\n"),
    expect: { decision: "no_learning" },
  },
  {
    id: "ambiguous-situational-rule",
    description: "borderline: a transferable decision rule wrapped in heavy situational detail. Strict bar -> decline; pass-rate is the signal",
    action: "review",
    provider: "file",
    task: fileTask(
      "EVAL-0010",
      "Review: continuation pass on a maintainer-owned PR",
      "Continuation review pass on a PR that a human maintainer has been actively developing.",
      "high",
    ),
    syntheticSession: [
      "A continuation review pass found the PR is now CONFLICTING. The branch is human-maintainer-owned and actively developed (13 human commits since my last push, already marked ready for review). The base (master) had advanced ~133 files across shared infra the maintainer's new code depends on; only one file conflicted textually.",
      "I deferred the base-integration to the maintainer rather than checking out the head and force-pushing a large speculative merge I couldn't validate against their code — a clean textual merge could still semantically break their work. There was no other current-head review feedback I could safely act on.",
    ].join("\n"),
    expect: { decision: "no_learning" },
  },
];
