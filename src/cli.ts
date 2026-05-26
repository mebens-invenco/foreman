#!/usr/bin/env node

import path from "node:path";

import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";

import { listRunnerRates } from "./execution/cost/rates.js";
import {
  isUsageGroupBy,
  rollupUsage,
  usageGroupByValues,
  type UsageBucket,
  type UsageGroupBy,
} from "./execution/cost/usage-rollup.js";
import { isIsoDate, resolveUsageRange } from "./execution/cost/usage-range.js";
import {
  formatWorkerResultValidationError,
  parseWorkerResult,
  validateWorkerResultForAction,
  workerResultActionValues,
  workerResultExample,
  workerResultSchema,
  type WorkerResultAction,
} from "./execution/worker-result.js";
import { ForemanVersionMonitor } from "./foreman-version.js";
import { createHttpServer } from "./http.js";
import { LoggerService } from "./logger.js";
import { buildAttemptStatusSnapshot } from "./orchestration/attempt-status-snapshot.js";
import { SchedulerService } from "./orchestration/index.js";
import { renderWorkspacePlan } from "./planning/render-workspace-plan.js";
import { attemptActivityKinds, type AttemptActivityKind } from "./repos/attempt-activity-repo.js";
import { createRepos } from "./repos/index.js";
import { openSqliteDatabase } from "./repos/impl/sqlite-database.js";
import { createReviewService, resolveGitHubAuthEnv } from "./review/index.js";
import { createSelfRebootScheduler, runRebootSidecar } from "./system/reboot.js";
import { createTaskSystem } from "./tasking/index.js";
import { discoverGitRepos } from "./workspace/git-repo-discovery.js";
import { initializeWorkspace, loadWorkspace } from "./workspace/index.js";
import type { LoggerLevelName } from "./logger.js";

const program = new Command();
const logLevels = ["debug", "info", "warn", "error"] as const satisfies readonly LoggerLevelName[];

const collectRepeatedValues = (value: string, previous: string[] = []): string[] => [...previous, value];

const parsePositiveInteger = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }

  return parsed;
};

const parseWorkerResultAction = (value: string): WorkerResultAction => {
  if (!workerResultActionValues.includes(value as WorkerResultAction)) {
    throw new InvalidArgumentError(`Action must be one of: ${workerResultActionValues.join(", ")}`);
  }

  return value as WorkerResultAction;
};

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
};

const resolveHelpAction = (): WorkerResultAction | undefined => {
  const actionArgIndex = process.argv.findIndex((arg) => arg === "--action" || arg.startsWith("--action="));
  const value = process.argv[actionArgIndex]?.startsWith("--action=")
    ? process.argv[actionArgIndex]!.slice("--action=".length)
    : process.argv[actionArgIndex + 1];

  return workerResultActionValues.includes(value as WorkerResultAction) ? (value as WorkerResultAction) : undefined;
};

const renderAgentResultValidateHelp = (): string => {
  const action = resolveHelpAction();
  const actionLiteral = action ?? `<${workerResultActionValues.join("|")}>`;
  const schema = action ? workerResultSchema.safeExtend({ action: z.literal(action) }) : workerResultSchema;
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema), null, 2);
  const exampleJson = JSON.stringify({
    ...workerResultExample,
    action: actionLiteral,
    ...((action === "review" || action === "reviewer") ? { outcome: "no_action_needed" } : {}),
  });
  const reviewGuidance = action === "review" || action === "reviewer"
    ? "\n- For no-op review results, use outcome `no_action_needed`; `completed` requires mutations or code changes."
    : "";

  return `
Action-specific accepted output shape

- Required action literal: \"${actionLiteral}\".
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

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const withWorkspaceRepos = async <T>(workspace: string, handler: (repos: ReturnType<typeof createRepos>) => Promise<T>): Promise<T> => {
  const { paths } = await loadWorkspace(workspace);
  const repos = createRepos(await openSqliteDatabase(paths.dbPath));
  try {
    await repos.migrationRunner.runMigrations(paths.projectRoot);
    return await handler(repos);
  } finally {
    repos.close();
  }
};

const parseUsageDate = (value: string): string => {
  if (!isIsoDate(value)) {
    throw new InvalidArgumentError("Date must be in YYYY-MM-DD format.");
  }
  return value;
};

const parseUsageGroupBy = (value: string): UsageGroupBy => {
  if (!isUsageGroupBy(value)) {
    throw new InvalidArgumentError(`Group-by must be one of: ${usageGroupByValues.join(", ")}`);
  }
  return value;
};

const formatUsd = (value: number): string => `$${value.toFixed(2)}`;

const formatUsageNumber = (value: number): string => value.toLocaleString("en-US");

const padCell = (value: string, width: number): string => value.padEnd(width, " ");

const renderUsageTable = (input: {
  groupBy: UsageGroupBy;
  fromDate: string;
  toDate: string;
  buckets: UsageBucket[];
  totals: UsageBucket;
}): string => {
  const groupHeader = input.groupBy === "day" ? "Day" : input.groupBy === "runner" ? "Runner" : "Runner/Model";
  const header = [groupHeader, "Attempts", "Fresh in", "Output", "Cache read", "Cache write", "Cost USD"];
  const rows = input.buckets.map((bucket) => [
    bucket.groupKey,
    formatUsageNumber(bucket.attemptsCount),
    formatUsageNumber(bucket.tokens.inputTokens),
    formatUsageNumber(bucket.tokens.outputTokens),
    formatUsageNumber(bucket.tokens.cacheReadInputTokens),
    formatUsageNumber(bucket.tokens.cacheCreationInputTokens),
    formatUsd(bucket.cost.totalUsd),
  ]);
  rows.push([
    "TOTAL",
    formatUsageNumber(input.totals.attemptsCount),
    formatUsageNumber(input.totals.tokens.inputTokens),
    formatUsageNumber(input.totals.tokens.outputTokens),
    formatUsageNumber(input.totals.tokens.cacheReadInputTokens),
    formatUsageNumber(input.totals.tokens.cacheCreationInputTokens),
    formatUsd(input.totals.cost.totalUsd),
  ]);

  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );

  const lines = [
    `Usage ${input.fromDate} to ${input.toDate} (grouped by ${input.groupBy}):`,
    header.map((cell, index) => padCell(cell, widths[index]!)).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => row.map((cell, index) => padCell(cell, widths[index]!)).join("  ")),
  ];

  return lines.join("\n");
};

const parseLogLevel = (value: string): LoggerLevelName => {
  const normalized = value.toLowerCase();
  if (!logLevels.includes(normalized as LoggerLevelName)) {
    throw new InvalidArgumentError(`Log level must be one of: ${logLevels.join(", ")}`);
  }

  return normalized as LoggerLevelName;
};

const resolveEntrypointPath = (): string => {
  if (process.argv[1]) {
    return path.resolve(process.argv[1]);
  }

  // Preserve a runnable built CLI path for embedders that do not set argv[1].
  return path.join(process.cwd(), "dist", "cli.js");
};

program.name("foreman").description("Workspace-scoped orchestration system");

program
  .command("init")
  .argument("<workspace>")
  .requiredOption("--task-system <type>", "Task system type", (value: string) => value, "linear")
  .action(async (workspace: string, options: { taskSystem: "linear" | "file" }) => {
    const paths = await initializeWorkspace(workspace, options.taskSystem);
    process.stdout.write(`Initialized workspace at ${paths.workspaceRoot}\n\n`);
    process.stdout.write("Next steps:\n");
    process.stdout.write(`1. fill in ${paths.envPath}\n`);
    process.stdout.write(`2. edit ${paths.configPath}\n`);
    process.stdout.write(`3. run foreman serve ${workspace}\n`);
  });

program
  .command("serve")
  .argument("<workspace>")
  .option("-l, --log-level <level>", "Minimum log level", parseLogLevel, "info")
  .action(async (workspace: string, options: { logLevel: LoggerLevelName }) => {
    const { config, paths, env } = await loadWorkspace(workspace);
    const logger = LoggerService.create({
      paths,
      context: { workspace: config.workspace.name, component: "cli.serve" },
      minLevel: options.logLevel,
    });
    logger.info("starting foreman service", { host: config.http.host, port: config.http.port });
    const resolvedEnv = await resolveGitHubAuthEnv(env, logger.child({ component: "review.github.auth" }));
    const repos = createRepos(await openSqliteDatabase(paths.dbPath));
    await repos.migrationRunner.runMigrations(paths.projectRoot);
    const repoRefs = await discoverGitRepos(config, paths);
    logger.info("discovered repositories for service startup", { repoCount: repoRefs.length });
    const taskSystem = createTaskSystem({
      config,
      paths,
      env: resolvedEnv,
      repos: repoRefs,
      logger: logger.child({ component: "taskSystem" }),
    });
    await taskSystem.validateStartup?.();
    logger.info("validated task system startup");
    await renderWorkspacePlan(workspace, repos, logger);

    const reviewService = createReviewService({ env: resolvedEnv, logger });
    const scheduler = new SchedulerService({
      config,
      paths,
      foremanRepos: repos,
      taskSystem,
      reviewService,
      repos: repoRefs,
      env: resolvedEnv,
      logger: logger.child({ component: "scheduler" }),
    });
    const versionMonitor = new ForemanVersionMonitor(paths);

    const server = createHttpServer({
      config,
      paths,
      repoRefs,
      repos,
      taskSystem,
      reviewService,
      scheduler,
      versionMonitor,
      rebootScheduler: createSelfRebootScheduler({
        config,
        paths,
        workspace,
        logLevel: options.logLevel,
        entrypointPath: resolveEntrypointPath(),
      }),
    });
    versionMonitor.start();
    await server.listen({ host: config.http.host, port: config.http.port });
    logger.info("http server listening", { host: config.http.host, port: config.http.port });
    await scheduler.start();
    logger.info("scheduler started from serve command");

    process.stdout.write(`Foreman serving workspace ${workspace} on http://${config.http.host}:${config.http.port}\n`);

    let shutdownPromise: Promise<void> | null = null;
    const shutdown = async (): Promise<void> => {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        logger.info("shutting down foreman service");
        versionMonitor.stop();
        await scheduler.stop();
        await server.close();
        repos.close();
        logger.info("foreman service stopped");
        await logger.flush();
        process.exit(0);
      })();

      return shutdownPromise;
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  });

const plan = program.command("plan");
plan
  .command("prompt")
  .argument("<workspace>")
  .option("-l, --log-level <level>", "Minimum log level", parseLogLevel, "info")
  .action(async (workspace: string, options: { logLevel: LoggerLevelName }) => {
    const { paths } = await loadWorkspace(workspace);
    const logger = LoggerService.create({
      paths,
      context: { workspace, component: "cli.plan" },
      minLevel: options.logLevel,
    });
    logger.info("rendering plan prompt from cli command");
    const repos = createRepos(await openSqliteDatabase(paths.dbPath));
    try {
      await repos.migrationRunner.runMigrations(paths.projectRoot);
      const result = await renderWorkspacePlan(workspace, repos, logger);
      logger.info("rendered plan prompt from cli command", { planPath: result.paths.planPath, contextPath: result.contextPath });
      process.stdout.write(`Rendered plan prompt to ${result.paths.planPath}\n`);
    } finally {
      repos.close();
      await logger.flush();
    }
  });

const learnings = program.command("learnings").description("Query workspace learnings from the workspace SQLite database");

learnings
  .command("search")
  .argument("<workspace>")
  .option("--repo <repo>", "Repo scope to include", collectRepeatedValues, [])
  .option("--query <query>", "Search query", collectRepeatedValues, [])
  .option("--limit <count>", "Maximum results to return", parsePositiveInteger, 20)
  .action(async (workspace: string, options: { repo: string[]; query: string[]; limit: number }) => {
    if (options.query.length === 0) {
      throw new InvalidArgumentError("At least one --query is required.");
    }

    await withWorkspaceRepos(workspace, async (repos) => {
      writeJson({
        workspace,
        repos: options.repo,
        queries: options.query,
        learnings: repos.learnings.searchLearnings(
          {
            queries: options.query,
            ...(options.repo.length > 0 ? { repos: options.repo } : {}),
            limit: options.limit,
          },
          { incrementReadCount: true },
        ),
      });
    });
  });

learnings
  .command("get")
  .argument("<workspace>")
  .requiredOption("--id <id>", "Learning id to fetch", collectRepeatedValues, [])
  .action(async (workspace: string, options: { id: string[] }) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      const learnings = repos.learnings.getLearningsByIds(options.id, { incrementReadCount: true });
      const foundIds = new Set(learnings.map((learning) => learning.id));
      writeJson({
        workspace,
        ids: options.id,
        learnings,
        missingIds: options.id.filter((id) => !foundIds.has(id)),
      });
    });
  });

program
  .command("usage")
  .description("Summarize per-attempt token usage and computed USD cost")
  .argument("<workspace>")
  .option("--from <date>", "Start date (inclusive), YYYY-MM-DD", parseUsageDate)
  .option("--to <date>", "End date (inclusive), YYYY-MM-DD", parseUsageDate)
  .option("--by <groupBy>", `Group by: ${usageGroupByValues.join("|")}`, parseUsageGroupBy, "day")
  .option("--json", "Emit JSON instead of the tab-aligned table")
  .action(async (workspace: string, options: { from?: string; to?: string; by: UsageGroupBy; json?: boolean }) => {
    const range = resolveUsageRange({
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.to !== undefined ? { to: options.to } : {}),
    });
    await withWorkspaceRepos(workspace, async (repos) => {
      const rows = repos.attempts.listUsageRows({
        fromInclusive: range.fromInclusive,
        toExclusive: range.toExclusive,
      });
      const rollup = rollupUsage({
        rows,
        groupBy: options.by,
        fromInclusive: range.fromInclusive,
        toExclusive: range.toExclusive,
      });

      if (options.json) {
        writeJson({
          workspace,
          fromDate: range.fromDate,
          toDate: range.toDate,
          groupBy: options.by,
          buckets: rollup.buckets,
          totals: rollup.totals,
          rates: listRunnerRates(),
        });
        return;
      }

      process.stdout.write(
        `${renderUsageTable({
          groupBy: options.by,
          fromDate: range.fromDate,
          toDate: range.toDate,
          buckets: rollup.buckets,
          totals: rollup.totals,
        })}\n`,
      );
    });
  });

const parseAttemptActivityKind = (value: string): AttemptActivityKind => {
  if (!(attemptActivityKinds as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`--kind must be one of: ${attemptActivityKinds.join(", ")}`);
  }
  return value as AttemptActivityKind;
};

const parseNonNegativeInteger = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Value must be a non-negative integer.");
  }
  return parsed;
};

const requireExactlyOne = (
  options: { attempt?: string; worker?: string },
): { kind: "attempt" | "worker"; id: string } => {
  const provided = [options.attempt && { kind: "attempt" as const, id: options.attempt }, options.worker && { kind: "worker" as const, id: options.worker }]
    .filter((entry): entry is { kind: "attempt" | "worker"; id: string } => Boolean(entry));
  if (provided.length !== 1) {
    throw new InvalidArgumentError("Specify exactly one of --attempt or --worker.");
  }
  return provided[0]!;
};

program
  .command("status")
  .description("Inspect deterministic status for an attempt or worker (read-only)")
  .argument("<workspace>")
  .option("--attempt <attemptId>", "Inspect status for this attempt")
  .option("--worker <workerId>", "Inspect status for this worker")
  .action(async (workspace: string, options: { attempt?: string; worker?: string }) => {
    const target = requireExactlyOne(options);

    await withWorkspaceRepos(workspace, async (repos) => {
      if (target.kind === "attempt") {
        const snapshot = buildAttemptStatusSnapshot(repos, target.id);
        writeJson({ workspace, attemptId: target.id, snapshot });
        return;
      }

      const worker = repos.workers.listWorkers().find((candidate) => candidate.id === target.id);
      if (!worker) {
        throw new InvalidArgumentError(`Worker not found: ${target.id}`);
      }

      const snapshot = worker.currentAttemptId
        ? buildAttemptStatusSnapshot(repos, worker.currentAttemptId)
        : null;
      writeJson({
        workspace,
        worker: {
          id: worker.id,
          slot: worker.slot,
          status: worker.status,
          currentAttemptId: worker.currentAttemptId,
          lastHeartbeatAt: worker.lastHeartbeatAt,
        },
        snapshot,
      });
    });
  });

program
  .command("tail")
  .description("Tail attempt activity rows (read-only)")
  .argument("<workspace>")
  .requiredOption("--attempt <attemptId>", "Attempt id to tail")
  .option("--activity", "Tail the activity feed", false)
  .option("--after-seq <seq>", "Return only rows with seq greater than this", parseNonNegativeInteger)
  .option("--limit <count>", "Maximum rows to return", parsePositiveInteger)
  .option("--kind <kind>", "Filter to a specific activity kind (repeatable)", (value, previous: AttemptActivityKind[] = []) => [
    ...previous,
    parseAttemptActivityKind(value),
  ], [] as AttemptActivityKind[])
  .action(async (
    workspace: string,
    options: { attempt: string; activity: boolean; afterSeq?: number; limit?: number; kind: AttemptActivityKind[] },
  ) => {
    if (!options.activity) {
      throw new InvalidArgumentError("Only --activity tailing is supported. Use --activity.");
    }

    await withWorkspaceRepos(workspace, async (repos) => {
      repos.attempts.getAttempt(options.attempt);
      const listOptions: { afterSeq?: number; limit?: number; kinds?: AttemptActivityKind[] } = {};
      if (options.afterSeq !== undefined) {
        listOptions.afterSeq = options.afterSeq;
      }
      if (options.limit !== undefined) {
        listOptions.limit = options.limit;
      }
      if (options.kind.length > 0) {
        listOptions.kinds = options.kind;
      }
      const activities = repos.attemptActivities.listActivities(options.attempt, listOptions);
      writeJson({
        workspace,
        attemptId: options.attempt,
        activities,
        latestSeq: activities.length > 0 ? activities[activities.length - 1]!.seq : (options.afterSeq ?? 0),
      });
    });
  });

program
  .command("stuck")
  .description("Report whether an attempt is stuck or needs human attention (read-only)")
  .argument("<workspace>")
  .requiredOption("--attempt <attemptId>", "Attempt id to inspect")
  .action(async (workspace: string, options: { attempt: string }) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      const snapshot = buildAttemptStatusSnapshot(repos, options.attempt);
      writeJson({
        workspace,
        attemptId: options.attempt,
        phase: snapshot.phase,
        stuck: snapshot.stuck,
        needsHuman: snapshot.needsHuman,
        repeatedFailureCandidates: snapshot.repeatedFailureCandidates,
        progressSummary: snapshot.progressSummary,
        currentOperation: snapshot.currentOperation,
      });
    });
  });

const agentResult = program.command("agent-result").description("Validate agent result output");

agentResult
  .command("validate")
  .description("Validate raw JSON or a complete <agent-result> block from stdin")
  .requiredOption("--action <action>", "Expected worker action", parseWorkerResultAction)
  .addHelpText("after", renderAgentResultValidateHelp)
  .action(async (options: { action: WorkerResultAction }) => {
    try {
      const value = parseWorkerResult(await readStdin());
      validateWorkerResultForAction(value, options.action);
      process.stdout.write(`Agent result is valid for action \"${options.action}\".\n`);
    } catch (error) {
      const message = error instanceof z.ZodError ? formatWorkerResultValidationError(error) : error instanceof Error ? error.message : String(error);
      process.stderr.write(`Agent result is invalid for action \"${options.action}\":\n${message}\n`);
      process.exitCode = 1;
    }
  });

const scheduler = program.command("scheduler");
for (const action of ["start", "pause", "stop"] as const) {
  scheduler.command(action).argument("<workspace>").action(async (workspace: string) => {
    const { config } = await loadWorkspace(workspace);
    const response = await fetch(`http://${config.http.host}:${config.http.port}/api/scheduler/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    process.stdout.write(`${await response.text()}\n`);
  });
}

program
  .command("reboot-sidecar", { hidden: true })
  .description("Internal command used to restart Foreman after graceful shutdown")
  .requiredOption("--workspace <workspace>")
  .requiredOption("--log-level <level>", "Minimum log level", parseLogLevel)
  .requiredOption("--host <host>")
  .requiredOption("--port <port>", "HTTP port", parsePositiveInteger)
  .requiredOption("--parent-pid <pid>", "Parent Foreman PID", parsePositiveInteger)
  .requiredOption("--entrypoint <path>")
  .action(async (options: { workspace: string; logLevel: LoggerLevelName; host: string; port: number; parentPid: number; entrypoint: string }) => {
    const { paths } = await loadWorkspace(options.workspace);
    await runRebootSidecar({
      paths,
      workspace: options.workspace,
      logLevel: options.logLevel,
      host: options.host,
      port: options.port,
      parentPid: options.parentPid,
      entrypointPath: path.resolve(options.entrypoint),
    });
  });

await program.parseAsync(process.argv);
