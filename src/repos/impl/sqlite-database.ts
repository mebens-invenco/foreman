import path from "node:path";

import Database from "better-sqlite3";

import { ensureDir } from "../../lib/fs.js";
import type { Database as ForemanDatabase } from "../database.js";

export type SqliteDatabase = Database.Database;
export type SqliteRow = Record<string, unknown>;

export type SqliteForemanDatabase = ForemanDatabase & {
  sqlite: SqliteDatabase;
};

class SqliteDatabaseConnection implements SqliteForemanDatabase {
  constructor(readonly sqlite: SqliteDatabase) {}

  close(): void {
    this.sqlite.close();
  }
}

export const openSqliteDatabase = async (dbPath: string, options?: { readonly?: boolean }): Promise<SqliteForemanDatabase> => {
  if (options?.readonly) {
    // Read-only consumers (e.g. eval-harvest against a live workspace) must not
    // create the DB, switch its journal mode, or take write locks. WAL reads
    // work without setting the pragma (the mode is a property of the DB file).
    const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    sqlite.pragma("foreign_keys = ON");
    return new SqliteDatabaseConnection(sqlite);
  }

  await ensureDir(path.dirname(dbPath));
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return new SqliteDatabaseConnection(sqlite);
};
