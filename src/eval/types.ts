import type { Task, TokenUsage, WorkerResult } from "../domain/index.js";
import type { WorkerPromptPullRequestReference } from "../execution/render-worker-prompt.js";
import type { WorkerResultAction } from "../execution/worker-result.js";

/**
 * End-of-run fixture: a synthetic "completed session" the model reflects on.
 * The harness renders the real worker prompt for `action`, appends the session,
 * runs it through a live runner, and the prompt's graders inspect the emitted
 * `<agent-result>`. Used by the learning-policy and summary-policy evals.
 */
export type CompletedSessionFixture = {
  type: "completed-session";
  /** Faithful account of the work that "just happened", injected post-render. */
  session: string;
};

/**
 * PR-review fixture: a synthetic PR-discovery context the reviewer reasons over
 * directly. The harness renders the reviewer (or reviewer-continuation) prompt
 * with the supplied `pullRequestReference` (and, for continuation cases, the
 * pre-resolved `priorCheckpoint`), then appends `discovery` — the complete,
 * faithful result of the `gh`/git PR discovery the reviewer would otherwise run.
 * The reviewer reasons on that material with no network access.
 */
export type PrReviewFixture = {
  type: "pr-review";
  /** Rendered into `{{context:pull-request}}` (overrides the live resolver). */
  pullRequestReference: WorkerPromptPullRequestReference;
  /** Selects the reviewer-continuation template when true. */
  continuation?: boolean;
  /**
   * Pre-resolved checkpoint for continuation cases, rendered into
   * `{{context:prior-checkpoint}}` (overrides the foremanRepos-resolved path).
   * Field names mirror `resolvePriorCheckpointContext` in render-worker-prompt.
   */
  priorCheckpoint?: Record<string, unknown>;
  /** The complete synthetic discovery result (diff, commits, threads, checks). */
  discovery: string;
};

/**
 * Live-PR fixture: the layer-2 counterpart of `PrReviewFixture`. The harness
 * clones `repo` into the eval workspace, force-checkouts `branch` at the pinned
 * `headSha` (a checkout that cannot land on the sha fails the run loudly —
 * frozen fixture PRs must never drift silently), renders the real reviewer
 * prompt against that worktree, and runs the sample with live `gh` discovery.
 * No synthetic block is appended: the reviewer performs its own PR discovery.
 * The worker result is captured and graded WITHOUT applying any mutations, so
 * the fixture PRs stay byte-frozen across runs.
 */
export type LivePrFixture = {
  type: "live-pr";
  /** GitHub `owner/name` of the fixture repo (e.g. "invenco/foreman-bench"). */
  repo: string;
  pullRequest: number;
  branch: string;
  /** Pinned head commit; the checkout is verified against this before every case. */
  headSha: string;
  /** Rendered as `headIntroducedAt` in the PR reference (post-head comment cutoff). */
  headIntroducedAt: string;
  /** Selects the reviewer-continuation template when true. */
  continuation?: boolean;
  /**
   * Pre-resolved checkpoint for continuation cases, rendered into
   * `{{context:prior-checkpoint}}`. The seeded prior-review threads live on the
   * real fixture PR; this carries the driver-side record of that prior pass
   * (its head, review id, and thread fingerprint), mirroring
   * `resolvePriorCheckpointContext` in render-worker-prompt.
   */
  priorCheckpoint?: Record<string, unknown>;
};

/** The scenario a case feeds into the rendered prompt — see `assembleCasePrompt`. */
export type EvalFixture = CompletedSessionFixture | PrReviewFixture | LivePrFixture;

/**
 * A single behavioral eval case: a scenario engineered to elicit (or to
 * correctly NOT elicit) a specific prompt-driven behavior.
 *
 * `fixture` is a discriminated union: a `completed-session` for the end-of-run
 * reflection prompts (learning-policy, summary-policy), or a `pr-review` for the
 * reviewer eval (a synthetic PR-discovery context the reviewer reasons over).
 *
 * `Expect` is the prompt-specific expectation payload. The harness core never
 * inspects it — only that prompt's graders do — so each prompt defines its own
 * shape (e.g. the learning-policy decision + scope) without touching the core.
 */
export type EvalCase<Expect = unknown> = {
  id: string;
  /** What behaviour this case probes — shown in the report. */
  description: string;
  /** Worker action whose prompt is rendered (e.g. "execution"). */
  action: WorkerResultAction;
  provider: "file" | "linear";
  /** Task scenario rendered into the worker prompt. */
  task: Task;
  /** The scenario fed into the rendered prompt. */
  fixture: EvalFixture;
  /** Prompt-specific expectation, consumed only by that prompt's graders. */
  expect: Expect;
};

/** One graded dimension of a single sample's output. */
export type GraderResult = {
  dimension: string;
  pass: boolean;
  /**
   * Set by the runner from the grader's `advisory` flag: an advisory dimension
   * is reported but does not gate the sample's pass.
   */
  advisory?: boolean;
  detail: string;
};

export type GradeContext<Expect = unknown> = {
  evalCase: EvalCase<Expect>;
  /** Parsed + action-validated worker result, or null if parse/validation failed. */
  result: WorkerResult | null;
  rawStdout: string;
  parseError?: string;
  /**
   * Harness-injected model call for LLM-as-judge graders. Absent when judging
   * is disabled (`--no-judge`); judge graders then no-op to a pass.
   */
  invokeModel?: (prompt: string) => Promise<string>;
};

export type Grader<Expect = unknown> = {
  name: string;
  /**
   * Advisory graders are reported but do NOT gate a sample's pass. The judge is
   * advisory until it's calibrated against human labels (TPR/TNR); an
   * uncalibrated judge must not fail a sample on its own.
   */
  advisory?: boolean;
  // `grade` is a method (not a function-typed property) on purpose: method
  // parameters are bivariant, so a prompt-specific `Grader<LearningExpect>`
  // stays assignable to the type-erased `Grader` the registry stores.
  grade(ctx: GradeContext<Expect>): GraderResult | Promise<GraderResult>;
};

export type SampleResult = {
  sampleIndex: number;
  parsed: boolean;
  graderResults: GraderResult[];
  /** A sample passes only when every non-advisory grader passes. */
  pass: boolean;
  /**
   * The parsed worker result, kept so a failing sample is diagnosable from the
   * report alone (what did the reviewer actually flag?) instead of only via
   * grader detail strings. Absent when parsing failed.
   */
  result?: WorkerResult;
  /** Runner-reported usage for this sample, when the runner surfaces it. */
  tokensUsed?: TokenUsage;
  elapsedSeconds?: number;
};

export type CaseResult = {
  caseId: string;
  description: string;
  samples: SampleResult[];
  /** Fraction of samples that passed — the headline metric under non-determinism. */
  passRate: number;
};

export type EvalReport = {
  prompt: string;
  runner: string;
  model: string;
  samplesPerCase: number;
  cases: CaseResult[];
  overallPassRate: number;
};

/** A prompt's registered eval: its cases + the graders applied to each sample. */
export type EvalDefinition<Expect = unknown> = {
  prompt: string;
  cases: EvalCase<Expect>[];
  graders: Grader<Expect>[];
};
