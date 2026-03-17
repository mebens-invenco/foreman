import YAML from "yaml";
import { z } from "zod";

export const schedulerSchema = z.object({
  workerConcurrency: z.number().int().positive().default(4),
  scoutPollIntervalSeconds: z.number().int().positive().default(60),
  scoutRerunDebounceMs: z.number().int().nonnegative().default(1000),
  leaseTtlSeconds: z.number().int().positive().default(120),
  workerHeartbeatSeconds: z.number().int().positive().default(15),
  staleLeaseReapIntervalSeconds: z.number().int().positive().default(15),
  schedulerLoopIntervalMs: z.number().int().positive().default(1000),
  shutdownGracePeriodSeconds: z.number().int().positive().default(10),
});

export const linearSchema = z.object({
  team: z.string().min(1),
  assignee: z.string().min(1).default("me"),
  includeLabels: z.array(z.string().min(1)).default(["Agent"]),
  consolidatedLabel: z.string().min(1).default("Agent Consolidated"),
  states: z.object({
    ready: z.array(z.string().min(1)).min(1).default(["Todo", "Ready"]),
    inProgress: z.array(z.string().min(1)).min(1).default(["In Progress"]),
    inReview: z.array(z.string().min(1)).min(1).default(["In Review"]),
    done: z.array(z.string().min(1)).min(1).default(["Done"]),
    canceled: z.array(z.string().min(1)).min(1).default(["Canceled"]),
  }),
});

export const fileTaskSchema = z.object({
  tasksDir: z.string().min(1).default("tasks"),
  idPrefix: z.string().min(1).default("TASK"),
  states: z.object({
    ready: z.array(z.string().min(1)).min(1).default(["ready"]),
    inProgress: z.array(z.string().min(1)).min(1).default(["in_progress"]),
    inReview: z.array(z.string().min(1)).min(1).default(["in_review"]),
    done: z.array(z.string().min(1)).min(1).default(["done"]),
    canceled: z.array(z.string().min(1)).min(1).default(["canceled"]),
  }),
});

export const reviewSystemSchema = z.object({
  type: z.literal("github").default("github"),
});

export const runnerSchema = z.object({
  type: z.literal("opencode").default("opencode"),
  model: z.string().min(1).default("openai/gpt-5.4"),
  variant: z.string().min(1).default("high"),
  timeoutMs: z.number().int().positive().default(3_600_000),
});

export const workspaceConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    workspace: z.object({
      name: z.string().min(1),
      agentPrefix: z.string().min(1).default("[agent] "),
    }),
    repos: z.object({
      explicit: z.array(z.string()).default([]),
      roots: z.array(z.string()).default([]),
      ignore: z.array(z.string()).default(["**/node_modules/**", "**/.git/**"]),
    }),
    taskSystem: z.object({
      type: z.enum(["linear", "file"]),
      linear: linearSchema.optional(),
      file: fileTaskSchema.optional(),
    }),
    reviewSystem: reviewSystemSchema.default({ type: "github" }),
    runner: runnerSchema.default({ type: "opencode", model: "openai/gpt-5.4", variant: "high", timeoutMs: 3_600_000 }),
    scheduler: schedulerSchema.default({
      workerConcurrency: 4,
      scoutPollIntervalSeconds: 60,
      scoutRerunDebounceMs: 1000,
      leaseTtlSeconds: 120,
      workerHeartbeatSeconds: 15,
      staleLeaseReapIntervalSeconds: 15,
      schedulerLoopIntervalMs: 1000,
      shutdownGracePeriodSeconds: 10,
    }),
    http: z.object({
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().positive().default(8765),
    }),
  })
  .superRefine((value, ctx) => {
    if (value.taskSystem.type === "linear" && !value.taskSystem.linear) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "taskSystem.linear must be configured when type=linear", path: ["taskSystem", "linear"] });
    }

    if (value.taskSystem.type === "file" && !value.taskSystem.file) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "taskSystem.file must be configured when type=file", path: ["taskSystem", "file"] });
    }
  });

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export const createDefaultWorkspaceConfig = (
  workspaceName: string,
  taskSystemType: "linear" | "file",
): WorkspaceConfig => ({
  version: 1,
  workspace: {
    name: workspaceName,
    agentPrefix: "[agent] ",
  },
  repos: {
    explicit: [],
    roots: [],
    ignore: ["**/node_modules/**", "**/.git/**"],
  },
  taskSystem:
    taskSystemType === "linear"
      ? {
          type: "linear",
          linear: {
            team: "Engineering",
            assignee: "me",
            includeLabels: ["Agent"],
            consolidatedLabel: "Agent Consolidated",
            states: {
              ready: ["Todo", "Ready"],
              inProgress: ["In Progress"],
              inReview: ["In Review"],
              done: ["Done"],
              canceled: ["Canceled"],
            },
          },
        }
      : {
          type: "file",
          file: {
            tasksDir: "tasks",
            idPrefix: "TASK",
            states: {
              ready: ["ready"],
              inProgress: ["in_progress"],
              inReview: ["in_review"],
              done: ["done"],
              canceled: ["canceled"],
            },
          },
        },
  reviewSystem: {
    type: "github",
  },
  runner: {
    type: "opencode",
    model: "openai/gpt-5.4",
    variant: "high",
    timeoutMs: 3_600_000,
  },
  scheduler: {
    workerConcurrency: 4,
    scoutPollIntervalSeconds: 60,
    scoutRerunDebounceMs: 1000,
    leaseTtlSeconds: 120,
    workerHeartbeatSeconds: 15,
    staleLeaseReapIntervalSeconds: 15,
    schedulerLoopIntervalMs: 1000,
    shutdownGracePeriodSeconds: 10,
  },
  http: {
    host: "127.0.0.1",
    port: 8765,
  },
});

export const parseWorkspaceConfig = (raw: string): WorkspaceConfig => {
  const parsed = YAML.parse(raw);
  return workspaceConfigSchema.parse(parsed);
};

export const stringifyWorkspaceConfig = (config: WorkspaceConfig): string => YAML.stringify(config);
