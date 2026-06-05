import type { Task } from "../domain/index.js";
import type { AttemptRecord, JobRecord } from "../repos/index.js";

export type TargetProgressState = "pending" | "active" | "in_review" | "merged" | "completed" | "retryable" | "blocked";

export const blockedTaskUpdatedAtContextKey = "blockedTaskUpdatedAt";

export const isBlockedOrdinaryWorkPendingUnblock = (task: Task, latestJob: JobRecord | null, latestAttempt: AttemptRecord | null): boolean => {
  if (!latestJob || (latestJob.action !== "execution" && latestJob.action !== "retry") || latestJob.status !== "blocked") {
    return false;
  }
  if (latestAttempt && latestAttempt.status !== "blocked") {
    return false;
  }

  const blockedTaskUpdatedAt = latestJob.selectionContext[blockedTaskUpdatedAtContextKey];
  if (typeof blockedTaskUpdatedAt !== "string") {
    return true;
  }

  const taskUpdatedAtTime = new Date(task.updatedAt).getTime();
  const blockedTaskUpdatedAtTime = new Date(blockedTaskUpdatedAt).getTime();
  if (Number.isNaN(taskUpdatedAtTime) || Number.isNaN(blockedTaskUpdatedAtTime)) {
    return true;
  }

  return task.updatedAt === blockedTaskUpdatedAt;
};
