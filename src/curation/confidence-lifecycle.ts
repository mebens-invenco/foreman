import type { LearningLifecycleRollup } from "../repos/learning-usage-repo.js";

export type Confidence = "emerging" | "established" | "proven";

/**
 * The lifecycle constants, in one place so the tests that pin the thresholds and
 * the rule that reads them can never drift apart.
 *
 * Promotion is keyed on DISTINCT tasks that applied a learning — never the raw
 * `applied_count`, which learning-policy inflates 3–6× by searching every
 * pipeline stage (the reason ENG-5701 exists). `distinctTasksRead` is reported
 * for context but never promotes: exposure is not endorsement.
 */
export const PROMOTE_TO_ESTABLISHED_MIN_DISTINCT_TASKS = 2;
export const PROMOTE_TO_PROVEN_MIN_DISTINCT_TASKS = 4;

/** Age, idleness, and epoch-grace all measure against the same window. */
export const DECAY_WINDOW_DAYS = 90;

/**
 * The instant task-attributed usage tracking began — ENG-5701's counter reset and
 * provenance stamping (migration 0033). Before it, no learning has a usage
 * history, so "idle for 90 days" is meaningless: an old learning would be archived
 * for silence the substrate could not have recorded. The grace term below refuses
 * every decay until a full window has elapsed since this instant.
 */
export const USAGE_EPOCH = "2026-07-14T00:00:00.000Z";

/** A learning the pass would raise to a higher confidence tier, and the evidence. */
export type PromotionProposal = {
  kind: "promote";
  learningId: string;
  title: string;
  repo: string;
  from: Confidence;
  to: Confidence;
  distinctTasksApplied: number;
  reason: string;
};

/** An emerging learning the pass would archive as decayed, and the evidence. */
export type DecayProposal = {
  kind: "decay";
  learningId: string;
  title: string;
  repo: string;
  from: Confidence;
  ageDays: number;
  idleDays: number | null;
  reason: string;
};

export type LifecycleProposal = PromotionProposal | DecayProposal;

/** The confidence tiers in ascending order — the one place their ordering lives. */
export const CONFIDENCE_RANK: Record<Confidence, number> = { emerging: 0, established: 1, proven: 2 };

const MS_PER_DAY = 86_400_000;

const daysBetween = (fromIso: string, to: Date): number =>
  Math.floor((to.getTime() - Date.parse(fromIso)) / MS_PER_DAY);

/**
 * The tier the evidence alone earns, as a function of distinct-task applies — not
 * of how many times the pass has run. Idempotent by construction: an emerging
 * learning four distinct tasks applied earns `proven` outright rather than
 * inching one tier per pass, so re-running the pass proposes nothing new.
 */
const earnedConfidence = (distinctTasksApplied: number): Confidence => {
  if (distinctTasksApplied >= PROMOTE_TO_PROVEN_MIN_DISTINCT_TASKS) return "proven";
  if (distinctTasksApplied >= PROMOTE_TO_ESTABLISHED_MIN_DISTINCT_TASKS) return "established";
  return "emerging";
};

const thresholdFor = (to: Confidence): number =>
  to === "proven" ? PROMOTE_TO_PROVEN_MIN_DISTINCT_TASKS : PROMOTE_TO_ESTABLISHED_MIN_DISTINCT_TASKS;

/**
 * The lifecycle decision as a pure function of values: given every active
 * learning's distinct-task signal and recency, plus `now` and the usage `epoch`,
 * the transitions the pass would make. No DB access, no clock of its own — so the
 * thresholds, the decay boundary, and the epoch grace are all decidable and
 * testable on values alone.
 *
 * Promotion only ever raises, and is checked first: a learning that earned a
 * higher tier is not a decay candidate, whatever its recency. Decay is confined
 * to `emerging` — the pass never demotes — and fires only once the learning, and
 * the usage substrate itself, are both a full window old and the learning has
 * gone a full window unread and unapplied.
 */
export const proposeConfidenceTransitions = (
  rollups: readonly LearningLifecycleRollup[],
  now: Date,
  epoch: Date,
): LifecycleProposal[] => {
  const windowMs = DECAY_WINDOW_DAYS * MS_PER_DAY;
  const idleBeforeMs = now.getTime() - windowMs;
  const epochGraceCleared = epoch.getTime() <= idleBeforeMs;
  const proposals: LifecycleProposal[] = [];

  for (const rollup of rollups) {
    const earned = earnedConfidence(rollup.distinctTasksApplied);
    if (CONFIDENCE_RANK[earned] > CONFIDENCE_RANK[rollup.confidence]) {
      proposals.push({
        kind: "promote",
        learningId: rollup.learningId,
        title: rollup.title,
        repo: rollup.repo,
        from: rollup.confidence,
        to: earned,
        distinctTasksApplied: rollup.distinctTasksApplied,
        reason: `${rollup.distinctTasksApplied} distinct tasks applied it (≥ ${thresholdFor(earned)} for ${earned})`,
      });
      continue;
    }

    if (rollup.confidence !== "emerging") continue;

    const createdOldEnough = Date.parse(rollup.createdAt) <= idleBeforeMs;
    const idleLongEnough = rollup.lastUsedAt === null || Date.parse(rollup.lastUsedAt) <= idleBeforeMs;
    if (!epochGraceCleared || !createdOldEnough || !idleLongEnough) continue;

    const ageDays = daysBetween(rollup.createdAt, now);
    const idleDays = rollup.lastUsedAt === null ? null : daysBetween(rollup.lastUsedAt, now);
    proposals.push({
      kind: "decay",
      learningId: rollup.learningId,
      title: rollup.title,
      repo: rollup.repo,
      from: "emerging",
      ageDays,
      idleDays,
      reason:
        idleDays === null
          ? `emerging, never read or applied, created ${ageDays}d ago`
          : `emerging, no read/apply usage in ${idleDays}d, created ${ageDays}d ago`,
    });
  }

  return proposals;
};
