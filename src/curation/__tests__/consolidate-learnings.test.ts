import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import type { Task } from "../../domain/index.js";
import { createMigratedDb, createTempDir, seedExecutionAttempt, testProjectRoot } from "../../test-support/helpers.js";
import { consolidateLearnings } from "../consolidate-learnings.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;
const MODEL = "fake-embedder-v1";

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createDb = async () => {
  const tempDir = await createTempDir("foreman-consolidate-test-");
  cleanupDirs.push(tempDir);
  return createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
};

type DbHandle = Awaited<ReturnType<typeof createMigratedDb>>;

// A unit vector whose cosine with [1, 0, 0] is exactly `cosine`.
const unitVectorAt = (cosine: number): Float32Array => Float32Array.from([cosine, Math.sqrt(1 - cosine * cosine), 0]);

const seed = (
  db: DbHandle,
  input: { id: string; vector: readonly number[]; repo?: string; duplicateOf?: string; updatedAt?: string },
): void => {
  const content = `body ${input.id}`;
  db.learnings.addLearning({
    id: input.id,
    title: input.id,
    repo: input.repo ?? "shared",
    confidence: "emerging",
    content,
    tags: [],
    ...(input.duplicateOf ? { duplicateOf: input.duplicateOf } : {}),
  });
  db.learnings.upsertLearningEmbedding({
    learningId: input.id,
    model: MODEL,
    dims: 3,
    vector: Float32Array.from(input.vector),
    embeddedTitle: input.id,
    embeddedContent: content,
  });
  if (input.updatedAt) {
    db.database.sqlite.prepare("UPDATE learning SET updated_at = ? WHERE id = ?").run(input.updatedAt, input.id);
  }
};

const task = (id: string): Task => ({
  id,
  provider: "file",
  providerId: id,
  title: id,
  description: "",
  state: "ready",
  providerState: "Todo",
  priority: "none",
  labels: [],
  assignee: null,
  targets: [{ repoKey: "foreman", branchName: id.toLowerCase(), position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-03-16T00:00:00Z",
  url: null,
});

const applyFromTask = (db: DbHandle, learningId: string, taskId: string): void => {
  const attempt = seedExecutionAttempt(db, { task: task(taskId), repoKey: "foreman", action: "execution" });
  db.learningUsage.recordApplied({ attemptId: attempt.id, taskId, action: "execution", learningId });
};

const consolidate = (db: DbHandle, apply: boolean) =>
  consolidateLearnings({ learnings: db.learnings, learningUsage: db.learningUsage, model: MODEL }, { apply });

describe("consolidateLearnings", () => {
  test("a dry run proposes the cluster but writes nothing", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "dup-old", vector: [1, 0, 0], updatedAt: "2026-07-09T00:00:00.000Z" });
      seed(db, { id: "dup-new", vector: [...unitVectorAt(0.9151)], updatedAt: "2026-07-13T00:00:00.000Z" });
      seed(db, { id: "distinct", vector: [0, 0, 1] });

      const report = consolidate(db, false);

      expect(report.applied).toBe(false);
      expect(report.threshold).toBe(0.91);
      expect(report.scanned).toBe(3);
      expect(report.corpus).toBe(3);
      expect(report.clusters).toHaveLength(1);
      expect(report.clusters[0]!.survivorId).toBe("dup-new");
      expect(report.clusters[0]!.survivorReason).toBe("recency_tiebreak");
      expect(report.clusters[0]!.loserIds).toEqual(["dup-old"]);

      // Nothing was archived or flagged: a dry run is inspection only.
      for (const id of ["dup-old", "dup-new", "distinct"]) {
        const [learning] = db.learnings.getLearningsByIds([id]);
        expect(learning?.archivedAt).toBeNull();
        expect(learning?.duplicateOf).toBeNull();
      }
    } finally {
      db.close();
    }
  });

  test("--apply archives the loser with duplicate_of set, leaves the survivor, and keeps history joinable", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "keep", vector: [1, 0, 0] });
      seed(db, { id: "drop", vector: [...unitVectorAt(0.9151)] });
      // `keep` wins on distinct-task applies; `drop` still has one, so archiving
      // (not deleting) must keep that usage row joinable.
      applyFromTask(db, "keep", "ENG-KEEP-A");
      applyFromTask(db, "keep", "ENG-KEEP-B");
      applyFromTask(db, "drop", "ENG-USED-DROP");

      const report = consolidate(db, true);
      expect(report.applied).toBe(true);
      expect(report.clusters[0]!.survivorId).toBe("keep");
      expect(report.clusters[0]!.loserIds).toEqual(["drop"]);

      const [survivor] = db.learnings.getLearningsByIds(["keep"]);
      expect(survivor?.archivedAt).toBeNull();
      expect(survivor?.duplicateOf).toBeNull();

      // The loser is archived and points at the survivor — still resolvable by id,
      // so the UI's duplicate_of link keeps working.
      const [loser] = db.learnings.getLearningsByIds(["drop"]);
      expect(loser?.archivedAt).toEqual(expect.any(String));
      expect(loser?.duplicateOf).toBe("keep");

      // Never deleted: the usage-event history still joins to the archived loser.
      expect(db.learningUsage.distinctTasksAppliedByIds(["drop"]).get("drop")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("--apply archives every loser of a multi-member transitive-chain cluster", async () => {
    const db = await createDb();
    try {
      // Three learnings on a 0.92 arc: a~b and b~c clear the bar, a~c does not, so
      // union-find still binds all three into one cluster with two losers. Pins that
      // the apply forwards EVERY loser, not just the first — the multi-loser path a
      // 2-member cluster can never exercise.
      const angle = Math.acos(0.92);
      const onArc = (multiple: number): number[] => [Math.cos(multiple * angle), Math.sin(multiple * angle), 0];
      seed(db, { id: "arc-a", vector: onArc(0), updatedAt: "2026-05-01T00:00:00.000Z" });
      seed(db, { id: "arc-b", vector: onArc(1), updatedAt: "2026-05-01T00:00:00.000Z" });
      seed(db, { id: "arc-c", vector: onArc(2), updatedAt: "2026-05-01T00:00:00.000Z" });

      const report = consolidate(db, true);
      expect(report.clusters).toHaveLength(1);
      expect(report.clusters[0]!.survivorId).toBe("arc-a");
      expect(report.clusters[0]!.loserIds).toEqual(["arc-b", "arc-c"]);

      // Both losers — not just the first — come back archived and flagged.
      for (const id of ["arc-b", "arc-c"]) {
        const [loser] = db.learnings.getLearningsByIds([id]);
        expect(loser?.archivedAt).toEqual(expect.any(String));
        expect(loser?.duplicateOf).toBe("arc-a");
      }
      const [survivor] = db.learnings.getLearningsByIds(["arc-a"]);
      expect(survivor?.archivedAt).toBeNull();
      expect(survivor?.duplicateOf).toBeNull();
    } finally {
      db.close();
    }
  });

  test("reports scan coverage so a zero-scan is distinct from a clean corpus", async () => {
    const db = await createDb();
    try {
      // Embedded under a DIFFERENT model, so the scan for MODEL finds no current
      // vectors and compares nothing over a non-empty corpus — the case that would
      // otherwise render as an all-clear.
      db.learnings.addLearning({ id: "unscanned", title: "unscanned", repo: "shared", confidence: "emerging", content: "b", tags: [] });
      db.learnings.upsertLearningEmbedding({
        learningId: "unscanned",
        model: "some-other-model",
        dims: 3,
        vector: Float32Array.from([1, 0, 0]),
        embeddedTitle: "unscanned",
        embeddedContent: "b",
      });

      const report = consolidate(db, false);
      expect(report.scanned).toBe(0);
      expect(report.corpus).toBe(1);
      expect(report.clusters).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a second run over an applied state proposes nothing", async () => {
    const db = await createDb();
    try {
      seed(db, { id: "a", vector: [1, 0, 0] });
      seed(db, { id: "b", vector: [...unitVectorAt(0.9151)] });

      expect(consolidate(db, true).clusters).toHaveLength(1);
      // The loser is archived, so it leaves the corpus and the cluster cannot re-form.
      expect(consolidate(db, false).clusters).toEqual([]);
      expect(consolidate(db, true).clusters).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a learning already flagged as a duplicate is skipped, so the scan only surfaces new drift", async () => {
    const db = await createDb();
    try {
      // `already-flagged` is a near-duplicate of `canonical`, but the write-time
      // check already pointed it at `canonical` and left it active. Re-proposing it
      // would double-handle a merge a human has already been shown.
      seed(db, { id: "canonical", vector: [1, 0, 0] });
      seed(db, { id: "already-flagged", vector: [...unitVectorAt(0.9151)], duplicateOf: "canonical" });

      expect(consolidate(db, false).clusters).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a cross-repo cluster surfaces each member's repo so review can catch a coverage-shrinking merge", async () => {
    const db = await createDb();
    try {
      // The foreman-scoped learning wins on usage, so a naive apply would archive
      // the shared one out of every other repo's retrieval. The report must carry
      // repo on both so a human can reject that.
      seed(db, { id: "shared-learning", vector: [1, 0, 0], repo: "shared" });
      seed(db, { id: "foreman-learning", vector: [...unitVectorAt(0.9151)], repo: "foreman" });
      applyFromTask(db, "foreman-learning", "ENG-USED");

      const report = consolidate(db, false);
      expect(report.clusters[0]!.survivorId).toBe("foreman-learning");
      expect(report.clusters[0]!.members.map((member) => ({ id: member.id, repo: member.repo }))).toEqual([
        { id: "foreman-learning", repo: "foreman" },
        { id: "shared-learning", repo: "shared" },
      ]);
    } finally {
      db.close();
    }
  });

  test("the survivor is chosen on task-distinct applies, not the raw applied_count", async () => {
    const db = await createDb();
    try {
      // `raw-heavy` has a fat applied_count column but no cross-task applies;
      // `task-proven` has an empty column but two distinct tasks that applied it.
      // The distinct-task rule must pick `task-proven`; the raw counter would not.
      seed(db, { id: "raw-heavy", vector: [1, 0, 0] });
      seed(db, { id: "task-proven", vector: [...unitVectorAt(0.9151)] });
      db.database.sqlite.prepare("UPDATE learning SET applied_count = 25 WHERE id = ?").run("raw-heavy");
      applyFromTask(db, "task-proven", "ENG-ONE");
      applyFromTask(db, "task-proven", "ENG-TWO");

      const report = consolidate(db, false);
      expect(report.clusters[0]!.survivorId).toBe("task-proven");
      expect(report.clusters[0]!.survivorReason).toBe("distinct_tasks_applied");
      expect(report.clusters[0]!.members[0]!.distinctTasksApplied).toBe(2);
      expect(report.clusters[0]!.loserIds).toEqual(["raw-heavy"]);
    } finally {
      db.close();
    }
  });
});
