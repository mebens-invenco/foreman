/**
 * The actions a learnings digest is pushed into, and so the only actions whose
 * attempts can carry an injection.
 */
export type LearningInjectionAction = "execution" | "retry" | "review";

export const learningInjectionActionValues: readonly LearningInjectionAction[] = ["execution", "retry", "review"];

export type InjectedLearningEvent = {
  learningId: string;
  /** 1-based position in the digest as the agent received it, most relevant first. */
  rank: number;
  /**
   * The cosine similarity the injection floor was cleared on — NOT the fused
   * score `learning_search_event.hit_scores` carries. The fused score is built
   * from ranks, so it is only comparable inside one query's candidate set;
   * cosine is absolute, and so is the only one of the two that means the same
   * thing across the attempts this telemetry is aggregated over.
   */
  cosineSimilarity: number;
};

export type LearningInjectionEventInput = {
  attemptId: string;
  taskId: string;
  action: LearningInjectionAction;
  /** The learnings that survived the token budget — what the prompt actually carried. */
  learnings: readonly InjectedLearningEvent[];
};

export type AppliedLearningRollup = {
  learningId: string;
  title: string;
  /** Attempts this learning was injected into. */
  injectedCount: number;
  /** ...of which this many went on to report it as applied. */
  appliedCount: number;
};

/**
 * The two M4 exit metrics, plus the counts they are derived from so a reader can
 * see the sample size a rate was computed over rather than trust the rate alone.
 *
 * Both rates share one cohort — attempts started inside the window — so the
 * numerator can never describe a different population than the denominator.
 */
export type LearningInjectionStats = {
  /** Attempts whose action can carry a digest at all; the honest denominator. */
  eligibleAttempts: number;
  attemptsWithInjection: number;
  /** `attemptsWithInjection / eligibleAttempts`, 0 when nothing was eligible. */
  attemptsWithInjectionRate: number;
  /** Distinct (attempt, learning) pairs injected. */
  injectedLearnings: number;
  /** ...of which the same attempt later reported applied. */
  appliedLearnings: number;
  /** `appliedLearnings / injectedLearnings`, 0 when nothing was injected. */
  hitRate: number;
  topAppliedLearnings: AppliedLearningRollup[];
};

export type LearningInjectionStatsFilters = {
  /** ISO instant; counts only attempts started at or after it. */
  since?: string;
  topLimit?: number;
};

export interface LearningInjectionEventRepo {
  /** One row per injected learning. No-op for an empty digest. */
  recordInjection(input: LearningInjectionEventInput): void;
  /**
   * Stamps `applied_at` on this attempt's injection rows for `learningId`.
   * Returns how many rows were stamped — zero when the attempt applied a
   * learning that was never injected into it, which is a legitimate outcome and
   * deliberately not an error: the hit-rate numerator counts injected∧applied,
   * so a learning the agent found on its own must not enter it.
   *
   * Already-stamped rows are left alone, so a replayed apply cannot move the
   * timestamp off the attempt that earned it.
   */
  markInjectedLearningApplied(input: { attemptId: string; learningId: string }): number;
  getInjectionStats(filters?: LearningInjectionStatsFilters): LearningInjectionStats;
}
