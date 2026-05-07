import { addSeconds } from "../lib/time.js";

const leaseConflictRequeueDelaySeconds = 15;

export const nextLeaseConflictEligibleAt = (): string => addSeconds(new Date(), leaseConflictRequeueDelaySeconds);
