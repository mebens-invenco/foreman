import type { AttemptStatus } from "../domain/index.js";
import type { AttemptEventRecord, AttemptRecord, LeaseResourceType, RecoveredAttemptRecord } from "./records.js";

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
