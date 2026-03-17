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

  private rowMatches(
    existing: Record<string, unknown> | undefined,
    incoming: Record<string, unknown>,
    columns: readonly string[],
  ): boolean {
    if (!existing) {
      return false;
    }

    return columns.every((column) => existing[column] === incoming[column]);
  }

  private skipOrThrowLegacyConflict(
    entity: string,
    identifier: string,
    existing: Record<string, unknown> | undefined,
    incoming: Record<string, unknown>,
    columns: readonly string[],
  ): boolean {
    if (!existing) {
      return false;
    }

    if (this.rowMatches(existing, incoming, columns)) {
      return true;
    }

    throw new ForemanError(
      "legacy_import_conflict",
      `Legacy import conflict for ${entity} ${identifier}: existing row differs from legacy data`,
      409,
    );
  }

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

  importLegacyDatabase(legacyDbPath: string): void {
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
        const selectLearning = this.sqlite.prepare(
          "SELECT id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at FROM learning WHERE id = ?",
        );
        const insertLearning = this.sqlite.prepare(
          "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        const selectHistory = this.sqlite.prepare(
          "SELECT step_id, created_at, stage, issue, summary FROM history_step WHERE step_id = ?",
        );
        const insertHistory = this.sqlite.prepare(
          "INSERT INTO history_step(step_id, created_at, stage, issue, summary) VALUES (?, ?, ?, ?, ?)",
        );
        const selectHistoryRepo = this.sqlite.prepare(
          "SELECT step_id, position, path, before_sha, after_sha FROM history_step_repo WHERE step_id = ? AND position = ?",
        );
        const insertHistoryRepo = this.sqlite.prepare(
          "INSERT INTO history_step_repo(step_id, position, path, before_sha, after_sha) VALUES (?, ?, ?, ?, ?)",
        );

        for (const row of learnings) {
          if (
            this.skipOrThrowLegacyConflict(
              "learning",
              String(row.id),
              selectLearning.get(row.id) as Record<string, unknown> | undefined,
              row,
              ["id", "title", "repo", "tags", "confidence", "content", "applied_count", "read_count", "created_at", "updated_at"],
            )
          ) {
            continue;
          }

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
          if (
            this.skipOrThrowLegacyConflict(
              "history step",
              String(row.step_id),
              selectHistory.get(row.step_id) as Record<string, unknown> | undefined,
              row,
              ["step_id", "created_at", "stage", "issue", "summary"],
            )
          ) {
            continue;
          }

          insertHistory.run(row.step_id, row.created_at, row.stage, row.issue, row.summary);
        }

        for (const row of historyRepos) {
          const historyStep = selectHistory.get(row.step_id) as Record<string, unknown> | undefined;
          if (!historyStep) {
            continue;
          }

          if (
            this.skipOrThrowLegacyConflict(
              "history repo",
              `${String(row.step_id)}:${String(row.position)}`,
              selectHistoryRepo.get(row.step_id, row.position) as Record<string, unknown> | undefined,
              row,
              ["step_id", "position", "path", "before_sha", "after_sha"],
            )
          ) {
            continue;
          }

          insertHistoryRepo.run(row.step_id, row.position, row.path, row.before_sha, row.after_sha);
        }
      })();
    } finally {
      legacy.close();
    }
  }
}
