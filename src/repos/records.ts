import type { ActionType, AttemptStatus, CheckState, JobStatus, ReviewContext } from "../domain/index.js";

export type LeaseResourceType = "job" | "task" | "branch";

export type JobRecord = {
  id: string;
  taskId: string;
  taskProvider: "linear" | "file";
  action: ActionType;
  status: JobStatus;
  priorityRank: number;
  repoKey: string;
  baseBranch: string | null;
  dedupeKey: string;
  selectionReason: string;
  selectionContext: Record<string, unknown>;
  scoutRunId: string | null;
  createdAt: string;
  updatedAt: string;
  leasedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
};

export type AttemptRecord = {
  id: string;
  jobId: string;
  workerId: string | null;
  attemptNumber: number;
  runnerName: "opencode";
  runnerModel: string;
  runnerVariant: string;
  status: AttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  summary: string;
  errorMessage: string | null;
};

export type WorkerRecord = {
  id: string;
  slot: number;
  status: "idle" | "leased" | "running" | "stopping" | "offline";
  currentAttemptId: string | null;
  lastHeartbeatAt: string;
};

export type RecoveredAttemptRecord = {
  attemptId: string;
  jobId: string;
  workerId: string | null;
};

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

export type AttemptEventRecord = {
  id: string;
  eventType: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ArtifactRecord = {
  id: string;
  ownerType: "workspace" | "job" | "execution_attempt" | "scout_run";
  ownerId: string;
  artifactType: "log" | "rendered_prompt" | "parsed_result" | "plan_prompt" | "plan_context";
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
};

export type ReviewCheckpointRecord = {
  id: string;
  taskId: string;
  prUrl: string;
  headSha: string;
  latestReviewSummaryId: string | null;
  latestConversationCommentId: string | null;
  checksFingerprint: string;
  mergeState: ReviewContext["mergeState"];
  recordedAt: string;
  sourceAttemptId: string;
};

export type LearningRecord = {
  id: string;
  title: string;
  repo: string;
  tags: string[];
  confidence: "emerging" | "established" | "proven";
  content: string;
  appliedCount: number;
  readCount: number;
  createdAt: string;
  updatedAt: string;
};

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

export type ReviewCheckpointFingerprint = {
  failing: CheckState[];
  pending: CheckState[];
};
