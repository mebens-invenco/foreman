import type { WorkerRecord } from "./records.js";

export interface WorkerRepo {
  ensureWorkerSlots(concurrency: number): void;
  listWorkers(): WorkerRecord[];
  updateWorkerStatus(workerId: string, status: WorkerRecord["status"], currentAttemptId: string | null): void;
  heartbeatWorker(workerId: string, attemptId: string | null, expiresAt: string): void;
}
