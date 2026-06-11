import type { Task, WorkerResult } from "../domain/index.js";
import type { WorkerResultAction } from "../execution/worker-result.js";

/**
 * A single behavioral eval case: a scenario engineered to elicit (or to
 * correctly NOT elicit) a specific prompt-driven behavior.
 *
 * The end-of-run prompts (learning-policy, summary-policy) carry a synthetic
 * "completed session" the model reflects on: the harness renders the real worker
 * prompt for `action`, appends the synthetic session, runs it through a live
 * runner, and the prompt's graders inspect the emitted `<agent-result>`.
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
  /** Faithful account of the work that "just happened", injected post-render. */
  syntheticSession: string;
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
