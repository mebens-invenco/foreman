/**
 * Activity substrate for live attempt observability.
 *
 * `execution_attempt_event` remains the durable lifecycle/audit trail for
 * Foreman-owned milestones. `execution_attempt_activity` adds a higher-volume,
 * per-attempt monotonically-numbered stream populated by both Foreman and
 * runner-normalized events.
 *
 * Activities are appended with a transactionally-allocated `seq` so consumers
 * can paginate with `afterSeq` without worrying about wall-clock ordering or
 * gaps.
 */

export const attemptActivityKinds = [
  "foreman_milestone",
  "operation_started",
  "operation_finished",
  "command_started",
  "command_finished",
  "tool_started",
  "tool_finished",
  "assistant_message",
  "reasoning",
  "diff",
  "progress",
  "warning",
  "error",
  "token_usage",
  "unknown",
] as const;

export type AttemptActivityKind = (typeof attemptActivityKinds)[number];

export const isAttemptActivityKind = (value: unknown): value is AttemptActivityKind =>
  typeof value === "string" && (attemptActivityKinds as readonly string[]).includes(value);

/**
 * A runner-line-derived activity that has been normalized into Foreman's
 * shared shape. Runners (Codex/Claude/Opencode) translate their native JSON
 * lines into zero or more of these; an unknown line MAY return a single
 * record with kind `"unknown"` or yield no record at all.
 */
export type NormalizedRunnerActivity = {
  kind: AttemptActivityKind;
  message: string;
  payload?: Record<string, unknown>;
};

export type AttemptActivityRecord = {
  id: string;
  executionAttemptId: string;
  seq: number;
  kind: AttemptActivityKind;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AppendActivityInput = {
  executionAttemptId: string;
  kind: AttemptActivityKind;
  message?: string;
  payload?: Record<string, unknown>;
};

export type ListActivitiesOptions = {
  afterSeq?: number;
  kinds?: AttemptActivityKind[];
  limit?: number;
};

export interface AttemptActivityRepo {
  appendActivity(input: AppendActivityInput): AttemptActivityRecord;
  listActivities(executionAttemptId: string, options?: ListActivitiesOptions): AttemptActivityRecord[];
  latestActivity(executionAttemptId: string): AttemptActivityRecord | null;
  latestActivityOfKind(executionAttemptId: string, kind: AttemptActivityKind): AttemptActivityRecord | null;
  countActivities(executionAttemptId: string, options?: { kind?: AttemptActivityKind }): number;
  /**
   * Trims the oldest rows for `executionAttemptId` so at most `maxRows`
   * remain. Returns the number of rows deleted. No-op when row count is
   * already within the limit.
   */
  trimRetention(executionAttemptId: string, maxRows: number): number;
}
