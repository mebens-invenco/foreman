import { describe, expect, test } from "vitest";

import { NEAR_DUPLICATE_SIMILARITY_THRESHOLD } from "../../orchestration/worker-result-applier.js";
import { scanForConsolidation, type ConsolidationInput } from "../consolidation-scan.js";

// A unit vector whose cosine with [1, 0, 0] is exactly `cosine` — the same trick
// the applier's near-duplicate tests use to pin an exact similarity between two
// learnings. The threshold is imported, never re-typed, so this suite fails with
// the calibration if the constant ever drifts out of the ticket's 0.9067/0.9151
// window.
const unitVectorAt = (cosine: number): Float32Array => Float32Array.from([cosine, Math.sqrt(1 - cosine * cosine), 0]);
const BASE = Float32Array.from([1, 0, 0]);

const input = (
  id: string,
  vector: Float32Array,
  overrides: { title?: string; repo?: string; distinctTasksApplied?: number; updatedAt?: string } = {},
): ConsolidationInput => ({
  id,
  title: overrides.title ?? `title-${id}`,
  repo: overrides.repo ?? "shared",
  vector,
  distinctTasksApplied: overrides.distinctTasksApplied ?? 0,
  updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
});

describe("scanForConsolidation", () => {
  test("merges a pair just above the threshold and leaves one just below it apart", () => {
    // 0.9151 is the weakest labelled duplicate, 0.9067 the strongest distinct
    // neighbour — the window 0.91 sits inside.
    const merged = scanForConsolidation(
      [input("a", BASE), input("b", unitVectorAt(0.9151))],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.members.map((member) => member.id).sort()).toEqual(["a", "b"]);

    const apart = scanForConsolidation(
      [input("a", BASE), input("b", unitVectorAt(0.9067))],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );
    expect(apart).toEqual([]);
  });

  test("picks the survivor by task-distinct applies, never the raw count, and says so", () => {
    const clusters = scanForConsolidation(
      [
        input("loser", BASE, { distinctTasksApplied: 1 }),
        input("winner", unitVectorAt(0.9151), { distinctTasksApplied: 3 }),
      ],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.survivorId).toBe("winner");
    expect(cluster.survivorReason).toBe("distinct_tasks_applied");
    expect(cluster.loserIds).toEqual(["loser"]);
    // Survivor first, then losers, in rank order.
    expect(cluster.members.map((member) => member.id)).toEqual(["winner", "loser"]);
    expect(cluster.members[0]!.distinctTasksApplied).toBe(3);
  });

  test("recency breaks the common tie where usage does not separate the cluster", () => {
    // The dominant path: no applies anywhere, so the newer updated_at wins. The
    // timestamps are distinct so the assertion tests recency, not the id fallback.
    const clusters = scanForConsolidation(
      [
        input("older", BASE, { updatedAt: "2026-07-09T00:00:00.000Z" }),
        input("newer", unitVectorAt(0.9151), { updatedAt: "2026-07-13T00:00:00.000Z" }),
      ],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.survivorId).toBe("newer");
    expect(clusters[0]!.survivorReason).toBe("recency_tiebreak");
    expect(clusters[0]!.loserIds).toEqual(["older"]);
  });

  test("more distinct-task applies win even against a newer updated_at", () => {
    // Puts the two survivor dimensions in direct conflict: the winner is OLDER but
    // more-applied. If the comparator ever checked recency first, the fresher entry
    // would win — so this pins applies as the primary key, not just as a tiebreak.
    const clusters = scanForConsolidation(
      [
        input("proven-older", BASE, { distinctTasksApplied: 2, updatedAt: "2026-07-01T00:00:00.000Z" }),
        input("fresh-unused", unitVectorAt(0.9151), { distinctTasksApplied: 1, updatedAt: "2026-07-31T00:00:00.000Z" }),
      ],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters[0]!.survivorId).toBe("proven-older");
    expect(clusters[0]!.survivorReason).toBe("distinct_tasks_applied");
    expect(clusters[0]!.loserIds).toEqual(["fresh-unused"]);
  });

  test("recency breaks a tie on equal NONZERO applies, not only at zero", () => {
    // The recency tiebreak must fire whenever applies are equal, not just in the
    // common 0/0 case — otherwise a comparator that special-cased 0/0 would pass.
    const clusters = scanForConsolidation(
      [
        input("older", BASE, { distinctTasksApplied: 2, updatedAt: "2026-07-01T00:00:00.000Z" }),
        input("newer", unitVectorAt(0.9151), { distinctTasksApplied: 2, updatedAt: "2026-07-31T00:00:00.000Z" }),
      ],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters[0]!.survivorId).toBe("newer");
    expect(clusters[0]!.survivorReason).toBe("recency_tiebreak");
    expect(clusters[0]!.loserIds).toEqual(["older"]);
  });

  test("the id is the final tiebreak so the survivor is total even on identical usage and recency", () => {
    const clusters = scanForConsolidation(
      [input("zzz", unitVectorAt(0.9151)), input("aaa", BASE)],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters[0]!.survivorId).toBe("aaa");
    expect(clusters[0]!.survivorReason).toBe("recency_tiebreak");
    expect(clusters[0]!.loserIds).toEqual(["zzz"]);
  });

  test("union-find clusters a transitive chain even when its ends fall short of the bar", () => {
    // Three points on an arc at 0.92 apart: adjacent pairs clear 0.91, the ends
    // (cos 2θ ≈ 0.693) do not — a chain the pairwise bar alone would split.
    const angle = Math.acos(0.92);
    const onArc = (multiple: number): Float32Array =>
      Float32Array.from([Math.cos(multiple * angle), Math.sin(multiple * angle), 0]);

    const clusters = scanForConsolidation(
      [input("a", onArc(0)), input("b", onArc(1)), input("c", onArc(2))],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.map((member) => member.id).sort()).toEqual(["a", "b", "c"]);

    // The report carries every intra-cluster pair, including the sub-threshold
    // transitive link, so the reviewer sees why the ends are here.
    const ac = clusters[0]!.pairwiseSimilarities.find((pair) => pair.left === "a" && pair.right === "c");
    expect(ac).toBeDefined();
    expect(ac!.similarity).toBeLessThan(NEAR_DUPLICATE_SIMILARITY_THRESHOLD);
    expect(clusters[0]!.pairwiseSimilarities).toHaveLength(3);
  });

  test("emits every cluster, sorted by survivor id, and drops singletons", () => {
    const clusters = scanForConsolidation(
      [
        input("m-dup", unitVectorAt(0.9151)),
        input("m", BASE),
        input("z-dup", Float32Array.from([0, 0.9151, Math.sqrt(1 - 0.9151 * 0.9151)])),
        input("z", Float32Array.from([0, 1, 0])),
        input("solo", Float32Array.from([0, 0, 1])),
      ],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters.map((cluster) => cluster.survivorId)).toEqual(["m", "z"]);
    expect(clusters.flatMap((cluster) => cluster.members.map((member) => member.id))).not.toContain("solo");
  });

  test("skips a corrupt-width pair instead of aborting the whole scan", () => {
    // A wrong-width vector cannot be cosined; the pairs touching it are skipped so
    // the healthy duplicate pair still clusters and nothing throws.
    const clusters = scanForConsolidation(
      [input("a", BASE), input("corrupt", Float32Array.from([9, 9, 9, 9])), input("a-dup", unitVectorAt(0.9151))],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members.map((member) => member.id).sort()).toEqual(["a", "a-dup"]);
  });

  test("carries each member's repo so a cross-repo merge is visible to review", () => {
    // A shared/foreman near-duplicate clusters globally. The rule is repo-blind,
    // so the repo-specific one can win and the shared one be archived — surfacing
    // repo on every member is what lets a reviewer catch that before applying.
    const clusters = scanForConsolidation(
      [
        input("shared-one", BASE, { repo: "shared" }),
        input("foreman-one", unitVectorAt(0.9151), { repo: "foreman", distinctTasksApplied: 4 }),
      ],
      NEAR_DUPLICATE_SIMILARITY_THRESHOLD,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.survivorId).toBe("foreman-one");
    expect(clusters[0]!.members.map((member) => ({ id: member.id, repo: member.repo }))).toEqual([
      { id: "foreman-one", repo: "foreman" },
      { id: "shared-one", repo: "shared" },
    ]);
  });

  test("an empty or single-learning corpus yields no clusters", () => {
    expect(scanForConsolidation([], NEAR_DUPLICATE_SIMILARITY_THRESHOLD)).toEqual([]);
    expect(scanForConsolidation([input("only", BASE)], NEAR_DUPLICATE_SIMILARITY_THRESHOLD)).toEqual([]);
  });
});
