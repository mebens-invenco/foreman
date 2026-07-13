import { newId } from "../../lib/ids.js";
import { isoNow } from "../../lib/time.js";
import type {
  AppliedLearningRollup,
  LearningInjectionEventInput,
  LearningInjectionEventRepo,
  LearningInjectionStats,
  LearningInjectionStatsFilters,
} from "../learning-injection-event-repo.js";
import { learningInjectionActionValues } from "../learning-injection-event-repo.js";
import type { SqliteDatabase, SqliteRow } from "./sqlite-database.js";

const DEFAULT_TOP_LIMIT = 10;

const injectionEligibleActions = learningInjectionActionValues.map(() => "?").join(", ");

/**
 * One clock for every metric: an attempt is in the window if it STARTED in it,
 * and its injections and their applied stamps come with it. Keying the events off
 * their own `created_at` instead would let a window slice an attempt in half —
 * counting a learning as injected while its apply, moments later, fell outside.
 */
const attemptStartedSince = (since: string | undefined): { clause: string; params: string[] } =>
  since ? { clause: " AND attempt.started_at >= ?", params: [since] } : { clause: "", params: [] };

/** A (attempt, learning) pair, so a learning injected into two attempts counts twice. */
const INJECTED_PAIR = "event.attempt_id || '|' || event.learning_id";

const rate = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);

export class SqliteLearningInjectionEventRepo implements LearningInjectionEventRepo {
  constructor(private readonly sqlite: SqliteDatabase) {}

  recordInjection(input: LearningInjectionEventInput): void {
    if (input.learnings.length === 0) {
      return;
    }

    const createdAt = isoNow();
    const insert = this.sqlite.prepare(
      `INSERT INTO learning_injection_event(
         id, attempt_id, task_id, action, learning_id, rank, cosine_similarity, applied_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    );

    this.sqlite.transaction(() => {
      for (const learning of input.learnings) {
        insert.run(
          newId(),
          input.attemptId,
          input.taskId,
          input.action,
          learning.learningId,
          learning.rank,
          learning.cosineSimilarity,
          createdAt,
        );
      }
    })();
  }

  markInjectedLearningApplied(input: { attemptId: string; learningId: string }): number {
    return this.sqlite
      .prepare(
        `UPDATE learning_injection_event
            SET applied_at = ?
          WHERE attempt_id = ?
            AND learning_id = ?
            AND applied_at IS NULL`,
      )
      .run(isoNow(), input.attemptId, input.learningId).changes;
  }

  getInjectionStats(filters: LearningInjectionStatsFilters = {}): LearningInjectionStats {
    const window = attemptStartedSince(filters.since);

    const eligibleAttempts = Number(
      (
        this.sqlite
          .prepare(
            `SELECT COUNT(*) AS eligible
               FROM execution_attempt AS attempt
               JOIN job ON job.id = attempt.job_id
              WHERE job.action IN (${injectionEligibleActions})${window.clause}`,
          )
          .get(...learningInjectionActionValues, ...window.params) as SqliteRow
      ).eligible,
    );

    const totals = this.sqlite
      .prepare(
        `SELECT COUNT(DISTINCT event.attempt_id) AS attempts_with_injection,
                COUNT(DISTINCT ${INJECTED_PAIR}) AS injected,
                COUNT(DISTINCT CASE WHEN event.applied_at IS NOT NULL THEN ${INJECTED_PAIR} END) AS applied
           FROM learning_injection_event AS event
           JOIN execution_attempt AS attempt ON attempt.id = event.attempt_id
          WHERE 1 = 1${window.clause}`,
      )
      .get(...window.params) as SqliteRow;

    const attemptsWithInjection = Number(totals.attempts_with_injection);
    const injectedLearnings = Number(totals.injected);
    const appliedLearnings = Number(totals.applied);

    return {
      eligibleAttempts,
      attemptsWithInjection,
      attemptsWithInjectionRate: rate(attemptsWithInjection, eligibleAttempts),
      injectedLearnings,
      appliedLearnings,
      hitRate: rate(appliedLearnings, injectedLearnings),
      topAppliedLearnings: this.listTopAppliedLearnings(window, filters.topLimit ?? DEFAULT_TOP_LIMIT),
    };
  }

  /**
   * Only learnings an attempt actually reported applying. The join to `learning`
   * is safe to make an inner one: deleting a learning cascades its events away,
   * so an event can never outlive the row it names.
   *
   * `HAVING`/`ORDER BY` repeat the aggregates rather than naming the aliases,
   * because `learning` carries an `applied_count` column of its own and an
   * unqualified alias resolves to THAT — silently filtering this rollup on the
   * honour-system counter it exists to check.
   */
  private listTopAppliedLearnings(
    window: { clause: string; params: string[] },
    limit: number,
  ): AppliedLearningRollup[] {
    const attemptsInjected = "COUNT(DISTINCT event.attempt_id)";
    const attemptsApplied = "COUNT(DISTINCT CASE WHEN event.applied_at IS NOT NULL THEN event.attempt_id END)";

    return this.sqlite
      .prepare(
        `SELECT event.learning_id,
                learning.title,
                ${attemptsInjected} AS attempts_injected,
                ${attemptsApplied} AS attempts_applied
           FROM learning_injection_event AS event
           JOIN execution_attempt AS attempt ON attempt.id = event.attempt_id
           JOIN learning ON learning.id = event.learning_id
          WHERE 1 = 1${window.clause}
          GROUP BY event.learning_id, learning.title
         HAVING ${attemptsApplied} > 0
          ORDER BY ${attemptsApplied} DESC, ${attemptsInjected} ASC, event.learning_id ASC
          LIMIT ?`,
      )
      .all(...window.params, limit)
      .map((row: unknown) => {
        const mapped = row as SqliteRow;
        return {
          learningId: String(mapped.learning_id),
          title: String(mapped.title),
          injectedCount: Number(mapped.attempts_injected),
          appliedCount: Number(mapped.attempts_applied),
        };
      });
  }
}
