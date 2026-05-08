import type { ActionType, JobStatus } from "../domain/index.js";

export type JobRecord = {
  id: string;
  jobKind: "task" | "cron";
  taskId: string | null;
  taskTargetId: string | null;
  taskProvider: "linear" | "file" | null;
  cronJobId: string | null;
  action: ActionType;
  status: JobStatus;
  priorityRank: number;
  repoKey: string | null;
  baseBranch: string | null;
  dedupeKey: string;
  selectionReason: string;
  selectionContext: Record<string, unknown>;
  scoutRunId: string | null;
  createdAt: string;
  updatedAt: string;
  leasedAt: string | null;
  nextEligibleAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
};

export interface JobRepo {
  activeJobCount(): number;
  hasActiveDedupeKey(dedupeKey: string): boolean;
  createJob(input: {
    taskId: string;
    taskTargetId: string;
    taskProvider: "linear" | "file";
    action: ActionType;
    priorityRank: number;
    repoKey: string;
    baseBranch?: string | null;
    dedupeKey: string;
    selectionReason: string;
    selectionContext?: Record<string, unknown>;
    scoutRunId?: string | null;
  }): JobRecord;
  createCronJob(input: {
    cronJobId: string;
    priorityRank?: number;
    dedupeKey: string;
    selectionReason: string;
    selectionContext?: Record<string, unknown>;
  }): JobRecord;
  listQueue(limit?: number): JobRecord[];
  listJobsByStatus(statuses: JobStatus[]): JobRecord[];
  latestJobForDedupeKey(dedupeKey: string): JobRecord | null;
  latestJobForTaskTarget(taskTargetId: string): JobRecord | null;
  getJob(jobId: string): JobRecord;
  updateJobStatus(
    jobId: string,
    status: JobStatus,
    patch?: {
      startedAt?: string | null;
      leasedAt?: string | null;
      finishedAt?: string | null;
      errorMessage?: string | null;
    },
  ): void;
  returnLeasedJobToQueue(jobId: string, options?: { nextEligibleAt?: string | null }): void;
  claimQueuedJobForWorker(jobId: string, workerId: string): boolean;
}
