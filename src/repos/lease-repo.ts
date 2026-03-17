export type LeaseResourceType = "job" | "task" | "branch";

export interface LeaseRepo {
  acquireLease(input: {
    resourceType: LeaseResourceType;
    resourceKey: string;
    workerId: string;
    attemptId?: string;
    expiresAt: string;
  }): boolean;
  releaseLeasesForAttempt(attemptId: string, reason: string): void;
  releaseLeaseByResource(resourceType: LeaseResourceType, resourceKey: string, reason: string): void;
  hasActiveTaskLease(taskId: string): boolean;
  reapExpiredLeases(now: string): number;
}
