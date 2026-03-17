import { z } from "zod";

import type { WorkerResult } from "./domain/index.js";

const taskMutationSchema = z.object({ type: z.literal("add_comment"), body: z.string().min(1) });

const reviewMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_pull_request"),
    title: z.string().min(1),
    body: z.string(),
    draft: z.boolean(),
    baseBranch: z.string().min(1),
    headBranch: z.string().min(1),
  }),
  z.object({
    type: z.literal("reopen_pull_request"),
    pullRequestUrl: z.string().url().optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    draft: z.boolean(),
    title: z.string().optional(),
    body: z.string().optional(),
  }),
  z.object({ type: z.literal("reply_to_review_summary"), reviewId: z.string().min(1), body: z.string().min(1) }),
  z.object({ type: z.literal("reply_to_thread_comment"), threadId: z.string().min(1), body: z.string().min(1) }),
  z.object({ type: z.literal("reply_to_pr_comment"), commentId: z.string().min(1), body: z.string().min(1) }),
  z.object({ type: z.literal("resolve_threads"), threadIds: z.array(z.string().min(1)).min(1) }),
]);

const learningMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    title: z.string().min(1),
    repo: z.string().min(1),
    confidence: z.enum(["emerging", "established", "proven"]),
    content: z.string().min(1),
    tags: z.array(z.string()),
  }),
  z.object({
    type: z.literal("update"),
    id: z.string().min(1),
    title: z.string().optional(),
    repo: z.string().optional(),
    confidence: z.enum(["emerging", "established", "proven"]).optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
    markApplied: z.boolean().optional(),
  }),
]);

const blockerSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

const workerResultSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.enum(["execution", "review", "retry", "consolidation"]),
  outcome: z.enum(["completed", "no_action_needed", "blocked", "failed"]),
  summary: z.string().min(1),
  taskMutations: z.array(taskMutationSchema),
  reviewMutations: z.array(reviewMutationSchema),
  learningMutations: z.array(learningMutationSchema),
  blockers: z.array(blockerSchema),
  signals: z.array(z.enum(["code_changed", "review_checkpoint_eligible"])),
});

export const validateWorkerResult = (value: unknown): WorkerResult => workerResultSchema.parse(value) as WorkerResult;
