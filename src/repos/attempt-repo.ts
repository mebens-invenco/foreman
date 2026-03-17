import type { AttemptStatus } from "../domain/index.js";
import type { LeaseResourceType } from "./lease-repo.js";

export type AttemptRecord = {
  id: string;
  jobId: string;
  workerId: string | null;
  attemptNumber: number;
  runnerName: "opencode";
  runnerModel: string;
  runnerVariant: string;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  summary: string;
  errorMessage: string | null;
};

export type AttemptEventRecord = {
  id: string;
  eventType: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type RecoveredAttemptRecord = {
  attemptId: string;
  jobId: string;
  workerId: string | null;
};

export interface AttemptRepo {
  createAttempt(input: {
    jobId: string;
    workerId: string;
    runnerModel: string;
    runnerVariant: string;
  }): AttemptRecord;
  createAttemptWithLeases(input: {
    jobId: string;
    workerId: string;
    runnerModel: string;
    runnerVariant: string;
    expiresAt: string;
    leases: Array<{ resourceType: LeaseResourceType; resourceKey: string }>;
  }): AttemptRecord | null;
  finalizeAttempt(
    attemptId: string,
    status: AttemptStatus,
    patch?: {
      finishedAt?: string;
      exitCode?: number | null;
      signal?: string | null;
      summary?: string;
      errorMessage?: string | null;
    },
  ): void;
  listAttempts(filters?: { status?: AttemptStatus; jobId?: string; limit?: number }): AttemptRecord[];
  getAttempt(attemptId: string): AttemptRecord;
  latestAttemptForJob(jobId: string): AttemptRecord | null;
  addAttemptEvent(attemptId: string, eventType: string, message: string, payload?: Record<string, unknown>): void;
  listAttemptEvents(attemptId: string): AttemptEventRecord[];
  recoverOrphanedRunningAttempts(reason: string): RecoveredAttemptRecord[];
}
