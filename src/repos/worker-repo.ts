export type WorkerRecord = {
  id: string;
  slot: number;
  status: "idle" | "leased" | "running" | "stopping" | "offline";
  currentAttemptId: string | null;
  lastHeartbeatAt: string;
};

export interface WorkerRepo {
  ensureWorkerSlots(concurrency: number): void;
  listWorkers(): WorkerRecord[];
  updateWorkerStatus(workerId: string, status: WorkerRecord["status"], currentAttemptId: string | null): void;
  heartbeatWorker(workerId: string, attemptId: string | null, expiresAt: string): void;
}
