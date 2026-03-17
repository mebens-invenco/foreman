import type { ActionType, JobStatus } from "../domain/index.js";

export type JobRecord = {
  id: string;
  taskId: string;
  taskProvider: "linear" | "file";
  action: ActionType;
  status: JobStatus;
  priorityRank: number;
  repoKey: string;
  baseBranch: string | null;
  dedupeKey: string;
  selectionReason: string;
  selectionContext: Record<string, unknown>;
  scoutRunId: string | null;
  createdAt: string;
  updatedAt: string;
  leasedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
};

export interface JobRepo {
  activeJobCount(): number;
  hasActiveDedupeKey(dedupeKey: string): boolean;
  createJob(input: {
    taskId: string;
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
  listQueue(limit?: number): JobRecord[];
  listJobsByStatus(statuses: JobStatus[]): JobRecord[];
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
  returnLeasedJobToQueue(jobId: string): void;
  claimQueuedJobForWorker(jobId: string, workerId: string): boolean;
}
