import { z } from "zod";

import type { WorkerResult } from "../domain/index.js";

export const workerResultActionValues = ["execution", "review", "reviewer", "retry", "deployment", "consolidation"] as const satisfies readonly WorkerResult["action"][];
export type WorkerResultAction = (typeof workerResultActionValues)[number];

export const workerResultExample = {
  schemaVersion: 1,
  action: "execution",
  outcome: "completed",
  summary: "Validated output.",
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [],
  blockers: [],
  signals: [],
} satisfies WorkerResult;

const taskPrioritySchema = z.enum(["urgent", "high", "normal", "none", "low"]);

const taskMutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_comment"), body: z.string().min(1) }),
  z.object({
    type: z.literal("create_task"),
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    repos: z.array(z.string().min(1)).min(1),
    priority: taskPrioritySchema.optional(),
    dependencies: z
      .object({
        taskIds: z.array(z.string().min(1)).optional(),
        baseTaskId: z.string().min(1).nullable().optional(),
      })
      .optional(),
    repoDependencies: z
      .array(
        z.object({
          taskTargetRepoKey: z.string().min(1),
          dependsOnRepoKey: z.string().min(1),
        }),
      )
      .optional(),
    branchName: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
  }),
]).superRefine((mutation, ctx) => {
  if (mutation.type === "create_task" && !mutation.description && !mutation.body) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["description"], message: "Either description or body is required" });
  }
});

const reviewMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_pull_request"),
    title: z.string().min(1),
    body: z.string(),
    draft: z.boolean(),
    baseBranch: z.string().min(1),
    headBranch: z.string().min(1),
  }),
  z.object({ type: z.literal("reply_to_review_summary"), reviewId: z.string().min(1), body: z.string().min(1) }),
  z.object({ type: z.literal("reply_to_thread_comment"), threadId: z.string().min(1), body: z.string().min(1) }),
  z.object({ type: z.literal("reply_to_pr_comment"), commentId: z.string().min(1), body: z.string().min(1) }),
  z.object({
    type: z.literal("submit_pull_request_review"),
    body: z.string().min(1),
    event: z.literal("COMMENT"),
    comments: z.array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        side: z.enum(["LEFT", "RIGHT"]).optional(),
        body: z.string().min(1),
      }),
    ),
  }),
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

const blockerSchema = z.string().min(1);

const workerResultBaseSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.enum(workerResultActionValues),
  outcome: z.enum(["completed", "no_action_needed", "succeeded", "in_progress", "follow_up_created", "blocked", "failed"]),
  summary: z.string().min(1),
  taskMutations: z.array(taskMutationSchema),
  reviewMutations: z.array(reviewMutationSchema),
  learningMutations: z.array(learningMutationSchema),
  blockers: z.array(blockerSchema),
  signals: z.array(z.enum(["code_changed", "review_checkpoint_eligible", "reviewer_checkpoint_eligible"])),
});

const deploymentOutcomes = ["succeeded", "in_progress", "follow_up_created", "blocked", "failed"] as const;

export const workerResultSchema = workerResultBaseSchema.superRefine((result, ctx) => {
  if (result.action !== "deployment") {
    if ((deploymentOutcomes as readonly string[]).includes(result.outcome) && result.outcome !== "blocked" && result.outcome !== "failed") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Deployment-only outcome is only valid for deployment action" });
    }
  } else if (!(deploymentOutcomes as readonly string[]).includes(result.outcome)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: `Deployment outcome must be one of: ${deploymentOutcomes.join(", ")}` });
  }

  if (
    (result.action === "review" || result.action === "reviewer") &&
    result.outcome === "completed" &&
    result.taskMutations.length === 0 &&
    result.reviewMutations.length === 0 &&
    !result.signals.includes("code_changed")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "Review results with no mutations or code changes must use no_action_needed so Foreman can checkpoint them",
    });
  }
});

export const formatWorkerResultValidationError = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");

export const parseWorkerResult = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Worker output was empty");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const openTag = "<agent-result>";
    const closeTag = "</agent-result>";
    let searchEnd = trimmed.length;

    while (searchEnd > 0) {
      const closeStart = trimmed.lastIndexOf(closeTag, searchEnd);
      if (closeStart === -1) {
        break;
      }

      const openStart = trimmed.lastIndexOf(openTag, closeStart);
      if (openStart === -1) {
        searchEnd = closeStart;
        continue;
      }

      const payload = trimmed.slice(openStart + openTag.length, closeStart).trim();

      try {
        return JSON.parse(payload);
      } catch {
        // Keep looking; earlier text can mention <agent-result> before the final answer block.
      }

      searchEnd = openStart;
    }

    throw new Error("Worker output did not contain a valid <agent-result> block");
  }
};

export const validateWorkerResult = (value: unknown): WorkerResult => workerResultSchema.parse(value) as WorkerResult;

export const validateWorkerResultForAction = (value: unknown, action: WorkerResultAction): WorkerResult =>
  workerResultSchema.safeExtend({ action: z.literal(action) }).parse(value) as WorkerResult;

// Serialises the worker result schema for a given action to the human-readable
// help text that both the `agent-result validate --help` command and the
// rendered worker prompts inline. Sourcing both from this single helper keeps
// the inline prompt schema honest against the validator as the schema evolves.
// Pass `undefined` for the generic, action-agnostic shape.
export const renderAgentResultSchemaHelp = (action?: WorkerResultAction): string => {
  const actionLiteral = action ?? `<${workerResultActionValues.join("|")}>`;
  const schema = action ? workerResultSchema.safeExtend({ action: z.literal(action) }) : workerResultSchema;
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);
  const exampleJson = JSON.stringify({
    ...workerResultExample,
    action: actionLiteral,
    ...((action === "review" || action === "reviewer") ? { outcome: "no_action_needed" } : {}),
  });
  const reviewGuidance =
    action === "review" || action === "reviewer"
      ? "\n- For no-op review results, use outcome `no_action_needed`; `completed` requires mutations or code changes."
      : "";

  return `
Action-specific accepted output shape

- Required action literal: "${actionLiteral}".
- Stdin may be either raw JSON or one complete <agent-result>...</agent-result> block containing JSON.
- The final answer returned to Foreman must contain exactly one <agent-result> block and no prose after it.
- The worker result JSON schema below is generated from Foreman's Zod worker result schema.
${reviewGuidance}

Worker result JSON schema:

\`\`\`json
${jsonSchema}
\`\`\`

Minimal raw JSON example:

${exampleJson}

Wrapped final answer example:

<agent-result>
${exampleJson}
</agent-result>
`;
};
