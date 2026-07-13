import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { SqliteLearningRepo } from "../impl/sqlite-learning-repo.js";
import { testProjectRoot } from "../../test-support/helpers.js";

const MIGRATIONS_DIR = path.join(testProjectRoot, "migrations");
const SNAPSHOT_MIGRATION = "0030_learning_embedding_text_snapshot.sql";

const applyMigration = (db: Database.Database, name: string): void => {
  db.exec(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
};

/** A database as it stood the moment before the snapshot columns existed. */
const openPreSnapshotDatabase = (): Database.Database => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql") && entry < SNAPSHOT_MIGRATION)
    .sort()) {
    applyMigration(db, migration);
  }

  return db;
};

const seedLegacyEmbedding = (
  db: Database.Database,
  input: { id: string; content: string; learningUpdatedAt: string; embeddingUpdatedAt: string },
): void => {
  db.prepare("INSERT INTO learning(id, title, repo, tags, confidence, content) VALUES (?, ?, 'shared', '[]', 'emerging', ?)").run(
    input.id,
    input.id,
    input.content,
  );
  db.prepare("UPDATE learning SET updated_at = ? WHERE id = ?").run(input.learningUpdatedAt, input.id);
  db.prepare("INSERT INTO learning_embedding(learning_id, model, dims, vector, updated_at) VALUES (?, 'm', 2, ?, ?)").run(
    input.id,
    Buffer.from(Float32Array.from([1, 0]).buffer),
    input.embeddingUpdatedAt,
  );
};

// The snapshot columns retire a timestamp comparison whose resolution is one
// millisecond. Backfilling them is the one moment where that ambiguity has to be
// resolved rather than carried forward — a snapshot copied beside the wrong
// vector agrees with itself forever, and no backfill would ever repair it.
describe("0030_learning_embedding_text_snapshot", () => {
  test("adopts a vector written strictly after its learning, and refuses the ambiguous cases", () => {
    const db = openPreSnapshotDatabase();

    try {
      const earlier = "2026-01-01T00:00:00.000Z";
      const later = "2026-02-01T00:00:00.000Z";

      // Unambiguously current: the vector was written after the learning settled.
      seedLegacyEmbedding(db, { id: "fresh", content: "body", learningUpdatedAt: earlier, embeddingUpdatedAt: later });
      // Unambiguously stale under the old rule, and must stay stale.
      seedLegacyEmbedding(db, { id: "stale", content: "body", learningUpdatedAt: later, embeddingUpdatedAt: earlier });
      // The ambiguity: this learning's text was rewritten in the SAME millisecond
      // the vector for its previous text was written. Nothing on disk can tell
      // that apart from a learning nobody touched.
      seedLegacyEmbedding(db, { id: "same-ms", content: "rewritten", learningUpdatedAt: earlier, embeddingUpdatedAt: earlier });

      applyMigration(db, SNAPSHOT_MIGRATION);
      const repo = new SqliteLearningRepo(db);

      // `same-ms` is re-embedded rather than blessed. Copying its current text
      // beside a vector computed from the previous text would have made the
      // snapshot check agree with itself, permanently.
      expect(repo.listLearningIdsMissingEmbedding("m")).toEqual(["same-ms", "stale"]);
      expect(repo.getCurrentLearningEmbeddings({ model: "m" }).map((row) => row.learningId)).toEqual(["fresh"]);

      const snapshots = db
        .prepare("SELECT learning_id, embedded_content FROM learning_embedding ORDER BY learning_id")
        .all() as { learning_id: string; embedded_content: string | null }[];
      expect(snapshots).toEqual([
        { learning_id: "fresh", embedded_content: "body" },
        { learning_id: "same-ms", embedded_content: null },
        { learning_id: "stale", embedded_content: null },
      ]);
    } finally {
      db.close();
    }
  });

  test("re-embedding an adopted row repairs it, so the corpus converges", () => {
    const db = openPreSnapshotDatabase();

    try {
      seedLegacyEmbedding(db, {
        id: "same-ms",
        content: "rewritten",
        learningUpdatedAt: "2026-01-01T00:00:00.000Z",
        embeddingUpdatedAt: "2026-01-01T00:00:00.000Z",
      });
      applyMigration(db, SNAPSHOT_MIGRATION);
      const repo = new SqliteLearningRepo(db);

      expect(repo.listLearningIdsMissingEmbedding("m")).toEqual(["same-ms"]);

      // One re-embed is the whole cost of refusing to guess, and it settles the
      // question for good: the snapshot now records the text that was embedded.
      const learning = repo.getLearningsByIds(["same-ms"])[0]!;
      expect(
        repo.upsertLearningEmbedding({
          learningId: learning.id,
          model: "m",
          dims: 2,
          vector: Float32Array.from([0, 1]),
          embeddedTitle: learning.title,
          embeddedContent: learning.content,
        }),
      ).toBe(true);

      expect(repo.listLearningIdsMissingEmbedding("m")).toEqual([]);
      expect(repo.countCurrentLearningEmbeddings({ model: "m" })).toBe(1);
    } finally {
      db.close();
    }
  });
});
