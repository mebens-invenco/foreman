import type { RunnerProvider, RunnerSessionRole } from "../domain/index.js";

export type RunnerSessionRecord = {
  id: string;
  taskTargetId: string;
  role: RunnerSessionRole;
  runnerName: RunnerProvider;
  runnerModel: string;
  runnerVariant: string;
  nativeSessionId: string | null;
  isActive: boolean;
  lastAttemptId: string | null;
  lastWorktreeHeadSha: string | null;
  lastReviewHeadSha: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunnerSessionSelector = {
  taskTargetId: string;
  role: RunnerSessionRole;
  runnerName: RunnerProvider;
  runnerModel: string;
  runnerVariant: string;
};

export interface RunnerSessionRepo {
  getActiveSession(selector: RunnerSessionSelector): RunnerSessionRecord | null;
  createSession(input: RunnerSessionSelector & { isActive: boolean; nativeSessionId?: string | null }): RunnerSessionRecord;
  updateSession(
    sessionId: string,
    patch: {
      nativeSessionId?: string | null;
      lastAttemptId?: string | null;
      lastWorktreeHeadSha?: string | null;
      lastReviewHeadSha?: string | null;
      isActive?: boolean;
    },
  ): void;
}
