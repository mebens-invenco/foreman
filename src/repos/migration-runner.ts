export interface MigrationRunner {
  runMigrations(projectRoot: string): Promise<void>;
}
