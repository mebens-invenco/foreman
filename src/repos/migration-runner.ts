export interface MigrationRunner {
  runMigrations(projectRoot: string): Promise<void>;
  importLegacyDatabase(legacyDbPath: string): void;
}
