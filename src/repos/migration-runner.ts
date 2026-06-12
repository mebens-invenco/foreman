export interface MigrationRunner {
  runMigrations(projectRoot: string): Promise<void>;
  /**
   * Verify the database has every migration this checkout ships, WITHOUT
   * applying anything. For read-only consumers (e.g. `eval-harvest` against a
   * live workspace) that must never mutate a DB owned by a running server.
   * Throws `migrations_pending` when the DB is behind this checkout.
   */
  assertMigrationsCurrent(projectRoot: string): Promise<void>;
}
