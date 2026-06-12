import type { Task } from "../domain/index.js";
import type { AttemptRecord, JobRecord } from "../repos/index.js";

export type TargetProgressState = "pending" | "active" | "in_review" | "merged" | "completed" | "retryable" | "blocked";

export const blockedTaskUpdatedAtContextKey = "blockedTaskUpdatedAt";

export type BlockedOrdinaryWorkEvaluation = {
  pendingUnblock: boolean;
  reason: "not_blocked" | "non_blocked_attempt" | "missing_marker" | "invalid_timestamp" | "matching_marker" | "task_updated";
  blockedTaskUpdatedAt: string | null;
};

export const evaluateBlockedOrdinaryWork = (
  task: Task,
  latestJob: JobRecord | null,
  latestAttempt: AttemptRecord | null,
): BlockedOrdinaryWorkEvaluation => {
  if (!latestJob || (latestJob.action !== "execution" && latestJob.action !== "retry") || latestJob.status !== "blocked") {
    return { pendingUnblock: false, reason: "not_blocked", blockedTaskUpdatedAt: null };
  }
  if (latestAttempt && latestAttempt.status !== "blocked") {
    return { pendingUnblock: false, reason: "non_blocked_attempt", blockedTaskUpdatedAt: null };
  }

  const blockedTaskUpdatedAt = latestJob.selectionContext[blockedTaskUpdatedAtContextKey];
  if (typeof blockedTaskUpdatedAt !== "string") {
    return { pendingUnblock: false, reason: "missing_marker", blockedTaskUpdatedAt: null };
  }

  const taskUpdatedAtTime = new Date(task.updatedAt).getTime();
  const blockedTaskUpdatedAtTime = new Date(blockedTaskUpdatedAt).getTime();
  if (Number.isNaN(taskUpdatedAtTime) || Number.isNaN(blockedTaskUpdatedAtTime)) {
    return { pendingUnblock: true, reason: "invalid_timestamp", blockedTaskUpdatedAt };
  }

  return taskUpdatedAtTime === blockedTaskUpdatedAtTime
    ? { pendingUnblock: true, reason: "matching_marker", blockedTaskUpdatedAt }
    : { pendingUnblock: false, reason: "task_updated", blockedTaskUpdatedAt };
};

export const isBlockedOrdinaryWorkPendingUnblock = (task: Task, latestJob: JobRecord | null, latestAttempt: AttemptRecord | null): boolean =>
  evaluateBlockedOrdinaryWork(task, latestJob, latestAttempt).pendingUnblock;
