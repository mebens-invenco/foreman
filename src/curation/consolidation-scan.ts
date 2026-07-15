import { cosineSimilarity } from "../retrieval/cosine-similarity.js";

/**
 * One learning as the scan sees it: its vector, plus the two fields the survivor
 * rule consumes. `distinctTasksApplied` is the task-distinct apply count with the
 * learning's own source task excluded (see `LearningUsageRepo`), never the raw
 * `applied_count` — recency only decides where usage does not.
 */
export type ConsolidationInput = {
  id: string;
  title: string;
  repo: string;
  vector: Float32Array;
  distinctTasksApplied: number;
  updatedAt: string;
};

export type ConsolidationMember = {
  id: string;
  title: string;
  repo: string;
  distinctTasksApplied: number;
  updatedAt: string;
};

/**
 * Why a cluster's survivor won, as a field rather than a sentence so callers
 * assert on it:
 * - `distinct_tasks_applied`: strictly more task-distinct applies than the runner-up.
 * - `recency_tiebreak`: applies did not separate the top, so the newer `updated_at`
 *   won (ties there fall to the id, for determinism, not for meaning).
 */
export type SurvivorReason = "distinct_tasks_applied" | "recency_tiebreak";

/** An unordered member pair and its cosine, with `left` < `right` by id. */
export type ConsolidationPair = {
  left: string;
  right: string;
  similarity: number;
};

export type ConsolidationCluster = {
  survivorId: string;
  survivorReason: SurvivorReason;
  /** Survivor first, then losers, all in survivor-rank order. */
  members: ConsolidationMember[];
  loserIds: string[];
  pairwiseSimilarities: ConsolidationPair[];
};

/**
 * Deterministic survivor order: most task-distinct applies first; ties fall to
 * the newer `updated_at` (recency wins where usage does not separate); ties there
 * fall to the id so the choice is total, never coin-flipped by sort stability.
 */
const bySurvivorRank = (left: ConsolidationInput, right: ConsolidationInput): number =>
  right.distinctTasksApplied - left.distinctTasksApplied ||
  right.updatedAt.localeCompare(left.updatedAt) ||
  left.id.localeCompare(right.id);

// `repo` rides along even though the survivor rule ignores it: the scan clusters
// globally, so a cross-repo cluster can archive a `shared` learning in favour of a
// repo-specific one — which drops it from every OTHER repo's retrieval. Surfacing
// repo is what lets the dry-run reviewer catch that before applying.
const toMember = (learning: ConsolidationInput): ConsolidationMember => ({
  id: learning.id,
  title: learning.title,
  repo: learning.repo,
  distinctTasksApplied: learning.distinctTasksApplied,
  updatedAt: learning.updatedAt,
});

/**
 * Near-duplicate clusters among `learnings`, each with a deterministically chosen
 * survivor. A cluster is a connected component under "pairwise cosine at or above
 * `threshold`", found by union-find, so a chain A~B~C clusters even when A and C
 * fall short of the bar directly.
 *
 * Pure: it reads no store and writes nothing. The caller supplies the corpus it
 * wants scanned (already archived- and flag-filtered) and the `threshold` — which
 * is `NEAR_DUPLICATE_SIMILARITY_THRESHOLD`, passed in rather than imported so this
 * module carries no dependency on the calibration that owns the constant.
 *
 * A pair whose vectors disagree in width, or whose cosine is non-finite, is a
 * corrupt row and is skipped rather than allowed to throw — one bad vector must
 * not abort the whole scan, the same robustness `nearestLearningEmbedding` keeps.
 */
export const scanForConsolidation = (
  learnings: readonly ConsolidationInput[],
  threshold: number,
): ConsolidationCluster[] => {
  const parent = learnings.map((_, index) => index);
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    // Path-compress so repeated finds over a large corpus stay near-flat.
    let current = node;
    while (parent[current] !== root) {
      const next = parent[current]!;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    parent[find(left)] = find(right);
  };

  const pairKey = (low: number, high: number): string => `${low}:${high}`;
  const similarityByPair = new Map<string, number>();

  for (let left = 0; left < learnings.length; left += 1) {
    for (let right = left + 1; right < learnings.length; right += 1) {
      const leftVector = learnings[left]!.vector;
      const rightVector = learnings[right]!.vector;
      // A same-model wrong-width row is corrupt; skip rather than let
      // cosineSimilarity throw and take the whole scan down.
      if (leftVector.length !== rightVector.length) {
        continue;
      }

      const similarity = cosineSimilarity(leftVector, rightVector);
      // A NaN component yields a NaN similarity, and every comparison against it
      // is false — recording it as an edge would be recording a poison pill.
      if (!Number.isFinite(similarity)) {
        continue;
      }

      similarityByPair.set(pairKey(left, right), similarity);
      if (similarity >= threshold) {
        union(left, right);
      }
    }
  }

  const componentsByRoot = new Map<number, number[]>();
  for (let index = 0; index < learnings.length; index += 1) {
    const root = find(index);
    const members = componentsByRoot.get(root) ?? [];
    members.push(index);
    componentsByRoot.set(root, members);
  }

  const clusters: ConsolidationCluster[] = [];
  for (const memberIndices of componentsByRoot.values()) {
    if (memberIndices.length < 2) {
      continue;
    }

    const ranked = memberIndices.map((index) => learnings[index]!).sort(bySurvivorRank);
    const survivor = ranked[0]!;
    const runnerUp = ranked[1]!;
    const survivorReason: SurvivorReason =
      survivor.distinctTasksApplied > runnerUp.distinctTasksApplied ? "distinct_tasks_applied" : "recency_tiebreak";

    const pairwiseSimilarities: ConsolidationPair[] = [];
    for (let a = 0; a < memberIndices.length; a += 1) {
      for (let b = a + 1; b < memberIndices.length; b += 1) {
        const low = Math.min(memberIndices[a]!, memberIndices[b]!);
        const high = Math.max(memberIndices[a]!, memberIndices[b]!);
        const similarity = similarityByPair.get(pairKey(low, high));
        // A corrupt pair that never got a similarity is left off the report
        // rather than shown as 0; the members can still cluster transitively.
        if (similarity === undefined) {
          continue;
        }
        pairwiseSimilarities.push({ left: learnings[low]!.id, right: learnings[high]!.id, similarity });
      }
    }
    pairwiseSimilarities.sort((left, right) => left.left.localeCompare(right.left) || left.right.localeCompare(right.right));

    clusters.push({
      survivorId: survivor.id,
      survivorReason,
      members: ranked.map(toMember),
      loserIds: ranked.slice(1).map((member) => member.id),
      pairwiseSimilarities,
    });
  }

  // A stable, explainable order for the report: by survivor id.
  return clusters.sort((left, right) => left.survivorId.localeCompare(right.survivorId));
};
