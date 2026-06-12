import { promises as fs } from "node:fs";
import path from "node:path";

import { ForemanError } from "../../lib/errors.js";
import { sha256File } from "../../lib/fs.js";
import { isoNow } from "../../lib/time.js";
import type { MigrationRunner } from "../migration-runner.js";
import type { SqliteDatabase } from "./sqlite-database.js";

export class SqliteMigrationRunner implements MigrationRunner {
  constructor(private readonly sqlite: SqliteDatabase) {}

  private async listMigrationFiles(projectRoot: string): Promise<string[]> {
    const migrationsDir = path.join(projectRoot, "migrations");
    return (await fs.readdir(migrationsDir)).filter((entry) => entry.endsWith(".sql")).sort();
  }

  private appliedVersions(): Map<string, string> {
    return new Map(
      this.sqlite
        .prepare("SELECT version, checksum FROM schema_migration")
        .all()
        .map((row: unknown) => {
          const mapped = row as Record<string, unknown>;
          return [String(mapped.version), String(mapped.checksum)] as const;
        }),
    );
  }

  async assertMigrationsCurrent(projectRoot: string): Promise<void> {
    const migrationFiles = await this.listMigrationFiles(projectRoot);

    let applied: Map<string, string>;
    try {
      applied = this.appliedVersions();
    } catch {
      // No schema_migration table — an uninitialized DB is maximally behind.
      throw new ForemanError("migrations_pending", "Workspace database has no applied migrations; start the server (or run a writable command) to migrate it first.", 409);
    }

    const pending: string[] = [];
    for (const fileName of migrationFiles) {
      const appliedChecksum = applied.get(fileName);
      if (appliedChecksum === undefined) {
        pending.push(fileName);
        continue;
      }
      // Same rule as runMigrations: a version name with diverged content is a
      // different migration, not an applied one.
      if (appliedChecksum !== (await sha256File(path.join(projectRoot, "migrations", fileName)))) {
        throw new ForemanError("migration_checksum_mismatch", `Migration ${fileName} checksum mismatch`, 500);
      }
    }

    if (pending.length > 0) {
      throw new ForemanError(
        "migrations_pending",
        `Workspace database is missing ${pending.length} migration(s) this checkout ships (${pending.join(", ")}); migrate it via the server or a writable command before reading.`,
        409,
      );
    }

    // Intentionally NOT symmetric: a DB *ahead* of this checkout (applied
    // versions the checkout doesn't ship) passes. Migrations are additive in
    // practice, and the realistic read-only scenario is a stale checkout
    // reading a newer live DB — hard-failing would block harmless reads. A
    // genuinely breaking newer schema surfaces as a SQL error on the read.
  }

  async runMigrations(projectRoot: string): Promise<void> {
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );

    const migrationFiles = await this.listMigrationFiles(projectRoot);
    const applied = this.appliedVersions();

    for (const fileName of migrationFiles) {
      const filePath = path.join(projectRoot, "migrations", fileName);
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
