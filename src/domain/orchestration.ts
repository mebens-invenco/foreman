import type { TaskPriority } from "./task.js";

export type RunnerProvider = "opencode" | "claude";

export type ActionType = "execution" | "review" | "reviewer" | "retry" | "deployment" | "consolidation" | "cron";

export type RunnerSessionRole = "implementation" | "reviewer";

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
  nativeSessionId?: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

export type AgentRunResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut?: boolean;
  timeoutMs?: number | null;
  startedAt: string;
  finishedAt: string;
  stdoutBytes: number;
  stderrBytes: number;
  nativeSessionId?: string;
  tokensUsed?: TokenUsage;
};

export type TaskCreateMutation = {
  type: "create_task";
  title: string;
  description?: string;
  body?: string;
  repos: string[];
  priority?: TaskPriority;
  dependencies?: {
    taskIds?: string[];
    baseTaskId?: string | null;
  };
  repoDependencies?: Array<{
    taskTargetRepoKey: string;
    dependsOnRepoKey: string;
  }>;
  branchName?: string;
};

export type TaskMutation = { type: "add_comment"; body: string } | TaskCreateMutation;

export type ReviewMutation =
  | {
      type: "create_pull_request";
      title: string;
      body: string;
      draft: boolean;
      baseBranch: string;
      headBranch: string;
    }
  | { type: "reply_to_review_summary"; reviewId: string; body: string }
  | { type: "reply_to_thread_comment"; threadId: string; body: string }
  | { type: "reply_to_pr_comment"; commentId: string; body: string }
  | {
      type: "submit_pull_request_review";
      body: string;
      event: "COMMENT";
      comments: Array<{
        path: string;
        line: number;
        side?: "LEFT" | "RIGHT";
        body: string;
      }>;
    }
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

export type Signal = "code_changed" | "review_checkpoint_eligible" | "reviewer_checkpoint_eligible";

export type WorkerResult = {
  schemaVersion: 1;
  action: ActionType;
  outcome: "completed" | "no_action_needed" | "succeeded" | "in_progress" | "follow_up_created" | "blocked" | "failed";
  summary: string;
  taskMutations: TaskMutation[];
  reviewMutations: ReviewMutation[];
  learningMutations: LearningMutation[];
  blockers: Blocker[];
  signals: Signal[];
};
