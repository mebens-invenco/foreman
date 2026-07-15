import { NEAR_DUPLICATE_SIMILARITY_THRESHOLD } from "../orchestration/worker-result-applier.js";
import type { LearningRepo } from "../repos/learning-repo.js";
import type { LearningUsageRepo } from "../repos/learning-usage-repo.js";
import { scanForConsolidation, type ConsolidationCluster } from "./consolidation-scan.js";

export type ConsolidationReport = {
  threshold: number;
  applied: boolean;
  /** Learnings actually compared (current-embedding for the model, non-archived, non-flagged). */
  scanned: number;
  /** Total non-archived learnings in the workspace — the denominator `scanned` is a coverage of. */
  corpus: number;
  clusters: ConsolidationCluster[];
};

type ConsolidateDeps = {
  learnings: LearningRepo;
  learningUsage: LearningUsageRepo;
  /** The model whose vector space to scan — the workspace's live embedder id. */
  model: string;
};

/**
 * The periodic second-pass dedup the write-time near-duplicate check cannot do:
 * it clusters the CURRENT corpus and catches learnings that converged after the
 * fact (e.g. an update that moved one onto another). Dry-run by default; `--apply`
 * archives each cluster's losers with `duplicate_of` set at the survivor.
 *
 * The scanned corpus is the current embeddings MINUS anything already flagged:
 * `getCurrentLearningEmbeddings` already drops archived rows, and a learning that
 * already carries a `duplicate_of` has been surfaced for review (by the write-time
 * check or a prior apply), so it is not this scan's target. That filter is also
 * what makes the flow idempotent — once a loser is archived and flagged, both
 * exclusions keep it out, so a second run re-forms no cluster and proposes nothing.
 */
export const consolidateLearnings = (deps: ConsolidateDeps, options: { apply: boolean }): ConsolidationReport => {
  const embeddings = deps.learnings.getCurrentLearningEmbeddings({ model: deps.model });
  const recordsById = new Map(
    deps.learnings.getLearningsByIds(embeddings.map((embedding) => embedding.learningId)).map((record) => [record.id, record]),
  );

  // Flagged-but-active rows still carry a current embedding, so they reach here —
  // drop them, keeping only learnings the scan has never proposed a merge for.
  const candidates = embeddings.flatMap((embedding) => {
    const record = recordsById.get(embedding.learningId);
    return record && record.duplicateOf === null ? [{ vector: embedding.vector, record }] : [];
  });

  const distinctTasksApplied = deps.learningUsage.distinctTasksAppliedByIds(candidates.map(({ record }) => record.id));

  const clusters = scanForConsolidation(
    candidates.map(({ vector, record }) => ({
      id: record.id,
      title: record.title,
      repo: record.repo,
      vector,
      distinctTasksApplied: distinctTasksApplied.get(record.id) ?? 0,
      updatedAt: record.updatedAt,
    })),
    NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
  );

  if (options.apply) {
    // The whole apply in one atomic batch: a partial apply could strand a
    // transitive-chain loser the re-scan would never re-cluster.
    deps.learnings.flagAndArchiveDuplicates(
      clusters.flatMap((cluster) => cluster.loserIds.map((loserId) => ({ id: loserId, duplicateOf: cluster.survivorId }))),
    );
  }

  // `scanned` / `corpus` disclose coverage the way `selectSimilarLearningsCovered`
  // does: a scan that compared nothing (scanned 0 of a non-empty corpus — e.g. the
  // embedder model does not match the stored vectors) must not read as a clean run.
  return {
    threshold: NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    applied: options.apply,
    scanned: candidates.length,
    corpus: deps.learnings.countLearnings(),
    clusters,
  };
};
