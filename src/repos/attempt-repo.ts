import type { AttemptStatus, RunnerProvider, TokenUsage } from "../domain/index.js";
import type { LeaseResourceType } from "./lease-repo.js";

/**
 * Routing for {@link AttemptRepo.recordAttemptMilestone}. Foreman-owned
 * lifecycle milestones currently double-write to `event` (durable audit) and
 * `activity` (live snapshot feed). Callers MUST be explicit so future audits
 * can grep for sites that diverge from the canonical pair.
 */
export type AttemptMilestoneTarget = "event" | "activity";

export type AttemptRecord = {
  id: string;
  jobId: string;
  jobKind: "task" | "cron";
  taskId: string | null;
  target: string | null;
  cronJobId: string | null;
  stage: string | null;
  workerId: string | null;
  attemptNumber: number;
  runnerName: RunnerProvider;
  runnerModel: string;
  runnerVariant: string;
  runnerSessionId: string | null;
  nativeSessionId: string | null;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  summary: string;
  errorMessage: string | null;
  tokensUsed: TokenUsage | null;
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

export type AttemptUsageRow = {
  runnerName: RunnerProvider;
  runnerModel: string;
  runnerVariant: string;
  startedAt: string;
  tokensUsed: TokenUsage | null;
};

export interface AttemptRepo {
  createAttempt(input: {
    jobId: string;
    workerId: string;
    runnerName: RunnerProvider;
    runnerModel: string;
    runnerVariant: string;
  }): AttemptRecord;
  createAttemptWithLeases(input: {
    jobId: string;
    workerId: string;
    runnerName: RunnerProvider;
    runnerModel: string;
    runnerVariant: string;
    expiresAt: string;
    leases: Array<{ resourceType: LeaseResourceType; resourceKey: string }>;
  }): AttemptRecord | null;
  linkRunnerSession(attemptId: string, runnerSessionId: string): void;
  finalizeAttempt(
    attemptId: string,
    status: AttemptStatus,
    patch?: {
      finishedAt?: string;
      exitCode?: number | null;
      signal?: string | null;
      summary?: string;
      errorMessage?: string | null;
      tokensUsed?: TokenUsage | null;
    },
  ): void;
  listAttempts(filters?: { status?: AttemptStatus; jobId?: string; limit?: number; offset?: number }): AttemptRecord[];
  listUsageRows(filters: { fromInclusive: string; toExclusive: string }): AttemptUsageRow[];
  getAttempt(attemptId: string): AttemptRecord;
  latestAttemptForJob(jobId: string): AttemptRecord | null;
  latestAttemptForTaskTarget(taskTargetId: string): AttemptRecord | null;
  addAttemptEvent(attemptId: string, eventType: string, message: string, payload?: Record<string, unknown>): void;
  listAttemptEvents(attemptId: string): AttemptEventRecord[];
  /**
   * Records a Foreman-owned milestone, routing it explicitly to the durable
   * `event` stream, the live `activity` stream, or both. Callers always pass
   * `writeTo` to keep duplication intentional.
   */
  recordAttemptMilestone(
    attemptId: string,
    name: string,
    message: string,
    payload: Record<string, unknown>,
    options: { writeTo: AttemptMilestoneTarget[] },
  ): void;
  recoverOrphanedRunningAttempts(reason: string, options?: { excludeWorkerIds?: string[] }): RecoveredAttemptRecord[];
}
