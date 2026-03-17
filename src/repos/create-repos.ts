import type { ForemanRepos } from "./foreman-repos.js";
import type { SqliteForemanDatabase } from "./impl/sqlite-database.js";
import { SqliteArtifactRepo } from "./impl/sqlite-artifact-repo.js";
import { SqliteAttemptRepo } from "./impl/sqlite-attempt-repo.js";
import { SqliteHistoryRepo } from "./impl/sqlite-history-repo.js";
import { SqliteJobRepo } from "./impl/sqlite-job-repo.js";
import { SqliteLearningRepo } from "./impl/sqlite-learning-repo.js";
import { SqliteLeaseRepo } from "./impl/sqlite-lease-repo.js";
import { SqliteMigrationRunner } from "./impl/sqlite-migration-runner.js";
import { SqliteReviewCheckpointRepo } from "./impl/sqlite-review-checkpoint-repo.js";
import { SqliteScoutRunRepo } from "./impl/sqlite-scout-run-repo.js";
import { SqliteWorkerRepo } from "./impl/sqlite-worker-repo.js";

export const createRepos = (database: SqliteForemanDatabase): ForemanRepos => {
  const sqlite = database.sqlite;
  return {
    database,
    migrationRunner: new SqliteMigrationRunner(sqlite),
    jobs: new SqliteJobRepo(sqlite),
    attempts: new SqliteAttemptRepo(sqlite),
    workers: new SqliteWorkerRepo(sqlite),
    leases: new SqliteLeaseRepo(sqlite),
    scoutRuns: new SqliteScoutRunRepo(sqlite),
    artifacts: new SqliteArtifactRepo(sqlite),
    reviewCheckpoints: new SqliteReviewCheckpointRepo(sqlite),
    learnings: new SqliteLearningRepo(sqlite),
    history: new SqliteHistoryRepo(sqlite),
    close(): void {
      database.close();
    },
  };
};
