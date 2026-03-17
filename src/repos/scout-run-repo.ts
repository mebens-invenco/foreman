import type { ActionType } from "../domain/index.js";
import type { ScoutRunRecord, ScoutRunTrigger } from "./records.js";

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
