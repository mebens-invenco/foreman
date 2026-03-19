import type { Database } from "./database.js";
import type { ArtifactRepo } from "./artifact-repo.js";
import type { AttemptRepo } from "./attempt-repo.js";
import type { HistoryRepo } from "./history-repo.js";
import type { JobRepo } from "./job-repo.js";
import type { LearningRepo } from "./learning-repo.js";
import type { LeaseRepo } from "./lease-repo.js";
import type { MigrationRunner } from "./migration-runner.js";
import type { ReviewCheckpointRepo } from "./review-checkpoint-repo.js";
import type { ScoutRunRepo } from "./scout-run-repo.js";
import type { TaskMirrorRepo } from "./task-mirror-repo.js";
import type { WorkerRepo } from "./worker-repo.js";

export type ForemanRepos = {
  database: Database;
  migrationRunner: MigrationRunner;
  jobs: JobRepo;
  attempts: AttemptRepo;
  workers: WorkerRepo;
  leases: LeaseRepo;
  scoutRuns: ScoutRunRepo;
  taskMirror: TaskMirrorRepo;
  artifacts: ArtifactRepo;
  reviewCheckpoints: ReviewCheckpointRepo;
  learnings: LearningRepo;
  history: HistoryRepo;
  close(): void;
};
