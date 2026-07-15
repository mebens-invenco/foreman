import type { ActionType } from "../domain/orchestration.js";

/**
 * The attempt a learning touch happened inside, and the task that attempt served.
 *
 * One object rather than two optional fields, because a touch stamped with an
 * attempt but no task (or the reverse) is not a weaker signal — it is an
 * uncountable one, and every distinct-task count would have to re-check the pair
 * at the read end. Taking the pair at the write boundary makes the half-stamped
 * row unrepresentable instead.
 */
export type LearningUsageSource = {
  attemptId: string;
  taskId: string;
};

export type LearningAppliedEventInput = LearningUsageSource & {
  action: ActionType;
  learningId: string;
};

/**
 * Per-learning usage as M5 promotion must read it.
 *
 * `readCount` / `appliedCount` are the raw counters, carried here unchanged so a
 * reader can see the inflation rather than take the corrected number on trust.
 * They count pipeline touches: learning-policy mandates a search per stage, so
 * one task's execution/review/reviewer stages each bump `readCount` for the same
 * learning, and a learning extracted mid-task can be applied by a later stage of
 * the task that produced it.
 *
 * `distinctTasksRead` / `distinctTasksApplied` are the promotion signal: how many
 * DISTINCT tasks used this learning, with the learning's own `source_task_id`
 * excluded. Pipeline depth collapses to 1, and a learning cannot vouch for
 * itself. Feed M5 thresholds these, never the raw counters.
 */
export type LearningUsageRollup = {
  learningId: string;
  title: string;
  repo: string;
  /** Null for a learning written before provenance existed; it has no self to echo. */
  sourceTaskId: string | null;
  readCount: number;
  appliedCount: number;
  distinctTasksRead: number;
  distinctTasksApplied: number;
  /** Touches by the learning's own source task — excluded above, reported so the echo stays visible. */
  selfEchoReads: number;
  selfEchoApplies: number;
};

export type LearningUsageStats = {
  learnings: LearningUsageRollup[];
  /**
   * Search/get events carrying no attempt stamp — ad-hoc human CLI use, and every
   * row written before the dimension existed. Excluded from every distinct-task
   * count above; surfaced so the exclusion is visible rather than silent.
   */
  unattributedReadEvents: number;
};

export type LearningUsageStatsFilters = {
  /** ISO instant; counts only usage events recorded at or after it. */
  since?: string;
  topLimit?: number;
};

export interface LearningUsageRepo {
  /**
   * One row per `markApplied`, injected or self-found. Unlike the injection
   * stamp — which only marks a learning the digest actually pushed — this records
   * every apply, because promotion asks "did other tasks find this useful", not
   * "did push work".
   */
  recordApplied(input: LearningAppliedEventInput): void;
  getUsageStats(filters?: LearningUsageStatsFilters): LearningUsageStats;
  /**
   * `distinctTasksApplied` per learning id — how many DISTINCT tasks applied each,
   * with the learning's own source task excluded (a learning cannot vouch for
   * itself), the same self-echo rule `getUsageStats` uses. The consolidation scan's
   * survivor rule reads this, never the raw `applied_count`. Ids with no qualifying
   * applies are still present in the map at 0; unknown ids are absent.
   */
  distinctTasksAppliedByIds(ids: readonly string[]): Map<string, number>;
}
