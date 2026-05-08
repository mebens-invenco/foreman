import { addSeconds } from "../lib/time.js";
import type { WorkspaceConfig } from "../workspace/config.js";

export const nextLeaseConflictEligibleAt = (config: WorkspaceConfig): string => addSeconds(new Date(), config.scheduler.leaseConflictRequeueDelaySeconds);
