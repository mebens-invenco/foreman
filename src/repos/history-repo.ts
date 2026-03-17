export type HistoryRepoRecord = {
  path: string;
  beforeSha: string;
  afterSha: string;
  position: number;
};

export type HistoryRecord = {
  stepId: string;
  createdAt: string;
  stage: string;
  issue: string;
  summary: string;
  repos: HistoryRepoRecord[];
};

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
