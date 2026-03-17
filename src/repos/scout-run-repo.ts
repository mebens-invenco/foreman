import type { ActionType } from "../domain/index.js";

export type ScoutRunTrigger = "startup" | "poll" | "worker_finished" | "task_mutation" | "lease_change" | "manual";

export type ScoutRunRecord = {
  id: string;
  triggerType: ScoutRunTrigger;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  selectedAction: ActionType | null;
  selectedTaskId: string | null;
  candidateCount: number;
  activeCount: number;
  terminalCount: number;
};

export interface ScoutRunRepo {
  createScoutRun(input: {
    triggerType: ScoutRunTrigger;
    candidateCount: number;
    activeCount: number;
    terminalCount: number;
    summary?: Record<string, unknown>;
  }): string;
  completeScoutRun(input: {
    id: string;
    selectedJobId?: string | null;
    selectedAction?: ActionType | null;
    selectedTaskId?: string | null;
    selectedReason?: string;
    status?: "completed" | "failed";
    summary?: Record<string, unknown>;
    errorMessage?: string | null;
  }): void;
  listScoutRuns(limit?: number): ScoutRunRecord[];
}
