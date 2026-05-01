import { promises as fs } from "node:fs";
import path from "node:path";

import { ForemanError } from "../../lib/errors.js";
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
        this.sqlite.pragma("defer_foreign_keys = ON");
        this.sqlite.exec(sql);
        this.sqlite
          .prepare("INSERT INTO schema_migration(version, checksum, applied_at) VALUES (?, ?, ?)")
          .run(fileName, checksum, isoNow());
      })();
    }
  }
}
