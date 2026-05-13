import type { TaskPriority } from "./task.js";

/**
 * Canonical set of runner provider identifiers persisted to the database.
 *
 * This is the single source of truth: the {@link RunnerProvider} type is
 * derived from this array so adding a new runner is a single-edit change.
 * Repos validate `runner_name` against this set on read and write — the
 * `execution_attempt` and `runner_session` tables intentionally hold no
 * DB-level CHECK on `runner_name` so the canonical set lives in one place.
 */
export const runnerProviders = ["opencode", "claude", "codex"] as const;

export type RunnerProvider = (typeof runnerProviders)[number];

export const isRunnerProvider = (value: unknown): value is RunnerProvider =>
  typeof value === "string" && (runnerProviders as readonly string[]).includes(value);

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

/**
 * Per-API-call token usage, normalized across runners.
 *
 * `inputTokens` is always the count of NEW (non-cached) input tokens for the call.
 * Codex emits `input_tokens` inclusive of `cached_input_tokens`; the Codex
 * extractor subtracts the cached portion so this field has consistent semantics
 * across Claude, Codex, and OpenCode. Summing per-attempt rows for a session
 * therefore produces clean session-level deltas without double-counting.
 *
 * `cacheCreationInputTokens` and `cacheReadInputTokens` mirror the underlying
 * provider semantics: cached portion served on the call, and tokens written
 * into the provider's cache during the call. Not every runner emits both.
 *
 * `reasoningOutputTokens` covers the hidden reasoning trace that some
 * providers (Codex, OpenCode) report alongside the visible output.
 */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
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
  baseBranch?: string;
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
