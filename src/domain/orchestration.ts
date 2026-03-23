export type RunnerProvider = "opencode";

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

export type TaskMutation = { type: "add_comment"; body: string };

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
  | { type: "reply_to_thread_comment"; threadId: string; body: string }
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

export type Blocker = string;

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
