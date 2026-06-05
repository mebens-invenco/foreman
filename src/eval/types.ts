import type { Task, WorkerResult } from "../domain/index.js";
import type { WorkerResultAction } from "../execution/worker-result.js";

/**
 * A single behavioral eval case: a scenario engineered to elicit (or to
 * correctly NOT elicit) a specific prompt-driven behavior.
 *
 * v1 targets the learning-policy write-back, which is an *end-of-run* step, so
 * a case carries a synthetic "completed session" the model is asked to reflect
 * on. The harness renders the real worker prompt for `action`, appends the
 * synthetic session, runs it through a live runner, and grades the emitted
 * `learningMutations`.
 */
export type EvalCase = {
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
  /** What the learning review should do given this session. */
  expect: "learning" | "no_learning";
  /**
   * Optional scope expectation for an emitted learning, checked by the advisory
   * `scopeGrader`: "shared" when the insight is clearly cross-repo, "repo-specific"
   * when it is local to one repo. Omit when the case expects no learning, or when
   * scope is not the dimension under test.
   */
  expectScope?: "shared" | "repo-specific";
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

export type GradeContext = {
  evalCase: EvalCase;
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

export type Grader = {
  name: string;
  /**
   * Advisory graders are reported but do NOT gate a sample's pass. The judge is
   * advisory until it's calibrated against human labels (TPR/TNR); an
   * uncalibrated judge must not fail a sample on its own.
   */
  advisory?: boolean;
  grade(ctx: GradeContext): GraderResult | Promise<GraderResult>;
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
export type EvalDefinition = {
  prompt: string;
  cases: EvalCase[];
  graders: Grader[];
};
