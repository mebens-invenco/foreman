import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type {
  LearningAppliedEventInput,
  LearningUsageRepo,
  LearningUsageRollup,
  LearningUsageStats,
  LearningUsageStatsFilters,
} from "../learning-usage-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const DEFAULT_TOP_LIMIT = 20;

/**
 * A read touch is (event, learning), not (event): `hit_ids` is a JSON array, so
 * one search that returned five learnings is five touches. `json_each` fans the
 * array back out into the rows the counts are taken over, and a zero-hit event
 * contributes none — which is what it touched.
 *
 * `attempt_id IS NOT NULL` is the ad-hoc-CLI exclusion. `task_id` is checked too,
 * though the pair is written together, because rows predating this dimension carry
 * neither and no future writer should be able to half-stamp one into these counts.
 */
const READ_TOUCHES = `SELECT hit.value AS learning_id, event.task_id AS task_id
                        FROM learning_search_event AS event
                        JOIN json_each(event.hit_ids) AS hit
                       WHERE event.attempt_id IS NOT NULL
                         AND event.task_id IS NOT NULL`;

const APPLY_TOUCHES = `SELECT event.learning_id AS learning_id, event.task_id AS task_id
                         FROM learning_applied_event AS event
                        WHERE 1 = 1`;

const recordedSince = (since: string | undefined): { clause: string; params: string[] } =>
  since ? { clause: " AND event.created_at >= ?", params: [since] } : { clause: "", params: [] };

/**
 * The self-echo filter, and the trap it steps around: `source_task_id` is NULL for
 * every learning written before provenance existed, and `task_id <> NULL` is NULL —
 * not true — in SQL's three-valued logic. Written as a bare inequality this
 * predicate would silently drop EVERY touch of EVERY null-source learning, gutting
 * the signal the table exists to produce. A learning with no source task has no
 * self to echo, so all of its touches count.
 */
const notSelfEcho = (touch: string): string =>
  `(learning.source_task_id IS NULL OR ${touch}.task_id <> learning.source_task_id)`;

const isSelfEcho = (touch: string): string =>
  `(learning.source_task_id IS NOT NULL AND ${touch}.task_id = learning.source_task_id)`;

/**
 * Reads and applies stay two independent aggregates over two CTEs, and are never
 * joined to each other. Joined, a learning with three reads and two applies would
 * fan out to six rows: the DISTINCT-task counts would survive it, but `self_echo_*`
 * count events, and each would come back multiplied by the other side's row count.
 */
const usageOver = (touch: string, cte: string, predicate: string, expression: string): string =>
  `(SELECT ${expression}
      FROM ${cte} AS ${touch}
     WHERE ${touch}.learning_id = learning.id
       AND ${predicate})`;

export class SqliteLearningUsageRepo implements LearningUsageRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  recordApplied(input: LearningAppliedEventInput): void {
    this.sqlite
      .prepare(
        `INSERT INTO learning_applied_event(
           id, attempt_id, task_id, action, learning_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), input.attemptId, input.taskId, input.action, input.learningId, isoNow());
  }

  getUsageStats(filters: LearningUsageStatsFilters = {}): LearningUsageStats {
    const window = recordedSince(filters.since);

    const rows = this.sqlite
      .prepare(
        `WITH reads AS (${READ_TOUCHES}${window.clause}),
              applies AS (${APPLY_TOUCHES}${window.clause})
         SELECT learning.id,
                learning.title,
                learning.repo,
                learning.source_task_id,
                learning.read_count,
                learning.applied_count,
                ${usageOver("r", "reads", notSelfEcho("r"), "COUNT(DISTINCT r.task_id)")} AS distinct_tasks_read,
                ${usageOver("r", "reads", isSelfEcho("r"), "COUNT(*)")} AS self_echo_reads,
                ${usageOver("a", "applies", notSelfEcho("a"), "COUNT(DISTINCT a.task_id)")} AS distinct_tasks_applied,
                ${usageOver("a", "applies", isSelfEcho("a"), "COUNT(*)")} AS self_echo_applies
           FROM learning
          WHERE learning.id IN (
                  SELECT learning_id FROM reads
                   UNION
                  SELECT learning_id FROM applies
                )
          ORDER BY distinct_tasks_applied DESC,
                   distinct_tasks_read DESC,
                   learning.id ASC
          LIMIT ?`,
      )
      .all(...window.params, ...window.params, filters.topLimit ?? DEFAULT_TOP_LIMIT)
      .map((row: unknown): LearningUsageRollup => {
        const mapped = row as SqliteRow;
        return {
          learningId: String(mapped.id),
          title: String(mapped.title),
          repo: String(mapped.repo),
          sourceTaskId: (mapped.source_task_id as string | null) ?? null,
          readCount: Number(mapped.read_count),
          appliedCount: Number(mapped.applied_count),
          distinctTasksRead: Number(mapped.distinct_tasks_read),
          distinctTasksApplied: Number(mapped.distinct_tasks_applied),
          selfEchoReads: Number(mapped.self_echo_reads),
          selfEchoApplies: Number(mapped.self_echo_applies),
        };
      });

    return { learnings: rows, unattributedReadEvents: this.countUnattributedReadEvents(window) };
  }

  distinctTasksAppliedByIds(ids: readonly string[]): Map<string, number> {
    const normalized = Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (normalized.length === 0) {
      return new Map();
    }

    // A correlated subquery per learning rather than the CTE rollup: no window,
    // no read side, and no ordering — just the one number the survivor rule reads.
    // `notSelfEcho` carries the three-valued-logic guard, so a null-source
    // learning keeps all of its applies instead of silently dropping them.
    const rows = this.sqlite
      .prepare(
        `SELECT learning.id AS learning_id,
                (SELECT COUNT(DISTINCT event.task_id)
                   FROM learning_applied_event AS event
                  WHERE event.learning_id = learning.id
                    AND ${notSelfEcho("event")}) AS distinct_tasks_applied
           FROM learning
          WHERE learning.id IN (${normalized.map(() => "?").join(", ")})`,
      )
      .all(...normalized) as SqliteRow[];

    return new Map(rows.map((row) => [String(row.learning_id), Number(row.distinct_tasks_applied)]));
  }

  /**
   * Read events that hit at least one learning but carry no attempt, so no task can
   * be attributed to them. `zero_hit = 0` keeps the figure to events that would
   * otherwise have counted: an event that returned nothing was excluded by touching
   * nothing, not by being unattributed.
   */
  private countUnattributedReadEvents(window: { clause: string; params: string[] }): number {
    return Number(
      (
        this.sqlite
          .prepare(
            `SELECT COUNT(*) AS unattributed
               FROM learning_search_event AS event
              WHERE event.attempt_id IS NULL
                AND event.zero_hit = 0${window.clause}`,
          )
          .get(...window.params) as SqliteRow
      ).unattributed,
    );
  }
}
