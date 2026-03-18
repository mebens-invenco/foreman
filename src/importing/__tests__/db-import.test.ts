import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { createLegacyMemoryDb, createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";

const projectRoot = testProjectRoot;

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("legacy import", () => {
  test("imports learning and history transactionally", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const dbPath = path.join(tempDir, "foreman.db");
    const legacyDbPath = path.join(tempDir, "legacy-memory.db");

    createLegacyMemoryDb(legacyDbPath);
    const db = await createMigratedDb(dbPath, projectRoot);

    try {
      db.migrationRunner.importLegacyDatabase(legacyDbPath);

      expect(db.learnings.listLearnings({ limit: 10 })).toHaveLength(1);
      expect(db.history.listHistory({ limit: 10 })).toHaveLength(1);
      expect(db.learnings.listLearnings({ search: "fixtures", limit: 10 })[0]?.title).toBe("Prefer repo fixtures");
    } finally {
      db.close();
    }
  });
});
