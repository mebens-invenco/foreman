import { promises as fs } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { ForemanError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { sha256File } from "../../lib/fs.js";
import { isoNow } from "../../lib/time.js";
import type { MigrationRunner } from "../migration-runner.js";
import type { SqliteDatabase } from "./sqlite-database.js";

export class SqliteMigrationRunner implements MigrationRunner {
  constructor(private readonly sqlite: SqliteDatabase) {}

  async runMigrations(projectRoot: string): Promise<void> {
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );

    const migrationsDir = path.join(projectRoot, "migrations");
    const migrationFiles = (await fs.readdir(migrationsDir))
      .filter((entry) => entry.endsWith(".sql"))
      .sort();

    const applied = new Map(
      this.sqlite
        .prepare("SELECT version, checksum FROM schema_migration")
        .all()
        .map((row: unknown) => {
          const mapped = row as Record<string, unknown>;
          return [String(mapped.version), String(mapped.checksum)] as const;
        }),
    );

    for (const fileName of migrationFiles) {
      const filePath = path.join(migrationsDir, fileName);
      const checksum = await sha256File(filePath);
      const existing = applied.get(fileName);

      if (existing) {
        if (existing !== checksum) {
          throw new ForemanError("migration_checksum_mismatch", `Migration ${fileName} checksum mismatch`, 500);
        }

        continue;
      }

      const sql = await fs.readFile(filePath, "utf8");
      this.sqlite.transaction(() => {
        this.sqlite.exec(sql);
        this.sqlite
          .prepare("INSERT INTO schema_migration(version, checksum, applied_at) VALUES (?, ?, ?)")
          .run(fileName, checksum, isoNow());
      })();
    }
  }

  private assertLegacyImportDestinationEmpty(): void {
    const tables = ["learning", "history_step", "history_step_repo"];
    for (const table of tables) {
      const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>;
      if (Number(row.count ?? 0) > 0) {
        throw new ForemanError(
          "legacy_import_destination_not_empty",
          `Destination table ${table} must be empty before import`,
        );
      }
    }
  }

  importLegacyDatabase(legacyDbPath: string): void {
    this.assertLegacyImportDestinationEmpty();
    const legacy = new Database(legacyDbPath, { readonly: true });
    try {
      const learnings = legacy
        .prepare(
          "SELECT id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at FROM learning",
        )
        .all() as Array<Record<string, unknown>>;
      const historySteps = legacy
        .prepare("SELECT step_id, created_at, stage, issue, summary FROM history_step")
        .all() as Array<Record<string, unknown>>;
      const historyRepos = legacy
        .prepare("SELECT step_id, position, path, before_sha, after_sha FROM history_step_repo")
        .all() as Array<Record<string, unknown>>;

      this.sqlite.transaction(() => {
        const insertLearning = this.sqlite.prepare(
          "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const insertHistory = this.sqlite.prepare(
          "INSERT INTO history_step(step_id, created_at, stage, issue, summary) VALUES (?, ?, ?, ?, ?)",
        );
        const insertHistoryRepo = this.sqlite.prepare(
          "INSERT INTO history_step_repo(step_id, position, path, before_sha, after_sha) VALUES (?, ?, ?, ?, ?)",
        );

        for (const row of learnings) {
          insertLearning.run(
            row.id,
            row.title,
            row.repo,
            row.tags,
            row.confidence,
            row.content,
            row.applied_count,
            row.read_count,
            row.created_at,
            row.updated_at,
          );
        }

        for (const row of historySteps) {
          insertHistory.run(row.step_id, row.created_at, row.stage, row.issue, row.summary);
        }

        for (const row of historyRepos) {
          insertHistoryRepo.run(row.step_id, row.position, row.path, row.before_sha, row.after_sha);
        }
      })();
    } finally {
      legacy.close();
    }
  }
}
