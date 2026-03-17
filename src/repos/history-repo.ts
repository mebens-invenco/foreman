import type { HistoryRecord } from "./records.js";

export interface HistoryRepo {
  addHistoryStep(input: {
    stepId?: string;
    createdAt?: string;
    stage: string;
    issue: string;
    summary: string;
    repos?: Array<{ path: string; beforeSha: string; afterSha: string }>;
  }): string;
  listHistory(limit?: number): HistoryRecord[];
}
