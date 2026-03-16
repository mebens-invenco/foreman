export type TaskProvider = "linear" | "file";
export type ReviewProvider = "github";
export type RunnerProvider = "opencode";
export type TaskState = "ready" | "in_progress" | "in_review" | "done" | "canceled";
export type TaskPriority = "urgent" | "high" | "normal" | "none" | "low";
export type ActionType = "execution" | "review" | "retry" | "consolidation";
export type JobStatus =
  | "queued"
  | "leased"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "canceled";
export type AttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "canceled"
  | "timed_out";

export type TaskArtifact = {
  type: "pull_request" | "commit" | "doc" | "link" | "other";
  url: string;
  title?: string;
  externalId?: string;
};

export type Task = {
  id: string;
  provider: TaskProvider;
  providerId: string;
  title: string;
  description: string;
  state: TaskState;
  providerState: string;
  priority: TaskPriority;
  labels: string[];
  assignee: string | null;
  repo: string | null;
  branchName: string | null;
  dependencies: {
    taskIds: string[];
    baseTaskId: string | null;
    branchNames: string[];
  };
  artifacts: TaskArtifact[];
  updatedAt: string;
  url: string | null;
};

export type TaskComment = {
  id: string;
  taskId: string;
  body: string;
  authorName: string | null;
  authorKind: "agent" | "human" | "system" | "unknown";
  createdAt: string;
  updatedAt: string | null;
};

export type ReviewSummary = {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  commitId: string;
};

export type ConversationComment = {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  url?: string;
};

export type ReviewThread = {
  id: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: ConversationComment[];
};

export type CheckState = {
  name: string;
  state: "pending" | "failure";
};

export type ReviewContext = {
  provider: ReviewProvider;
  pullRequestUrl: string;
  pullRequestNumber: number;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  headIntroducedAt: string;
  mergeState: "clean" | "conflicting" | "dirty" | "unknown";
  actionableReviewSummaries: ReviewSummary[];
  actionableConversationComments: ConversationComment[];
  unresolvedThreads: ReviewThread[];
  failingChecks: CheckState[];
  pendingChecks: CheckState[];
};

export type AgentRunRequest = {
  attemptId: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  timeoutMs: number;
};

export type AgentRunResult = {
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  finishedAt: string;
  stdoutBytes: number;
  stderrBytes: number;
};

export type TaskMutation =
  | { type: "add_comment"; body: string }
  | { type: "upsert_artifact"; artifact: TaskArtifact };

export type ReviewMutation =
  | {
      type: "create_pull_request";
      title: string;
      body: string;
      draft: boolean;
      baseBranch: string;
      headBranch: string;
    }
  | {
      type: "reopen_pull_request";
      pullRequestUrl?: string;
      pullRequestNumber?: number;
      draft: boolean;
      title?: string;
      body?: string;
    }
  | { type: "reply_to_review_summary"; reviewId: string; body: string }
  | { type: "reply_to_pr_comment"; commentId: string; body: string }
  | { type: "resolve_threads"; threadIds: string[] };

export type LearningMutation =
  | {
      type: "add";
      title: string;
      repo: string;
      confidence: "emerging" | "established" | "proven";
      content: string;
      tags: string[];
    }
  | {
      type: "update";
      id: string;
      title?: string;
      repo?: string;
      confidence?: "emerging" | "established" | "proven";
      content?: string;
      tags?: string[];
      markApplied?: boolean;
    };

export type Blocker = {
  code: string;
  message: string;
};

export type Signal = "code_changed" | "review_checkpoint_eligible";

export type WorkerResult = {
  schemaVersion: 1;
  action: ActionType;
  outcome: "completed" | "no_action_needed" | "blocked" | "failed";
  summary: string;
  taskMutations: TaskMutation[];
  reviewMutations: ReviewMutation[];
  learningMutations: LearningMutation[];
  blockers: Blocker[];
  signals: Signal[];
};

export type RepoRef = {
  key: string;
  rootPath: string;
  defaultBranch: string;
};
