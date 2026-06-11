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
  renderAgentResultSchemaHelp,
  validateWorkerResultForAction,
  workerResultActionValues,
  type WorkerResultAction,
} from "./execution/worker-result.js";
import { ForemanVersionMonitor } from "./foreman-version.js";
import { createHttpServer } from "./http.js";
import { LoggerService } from "./logger.js";
import { SchedulerService } from "./orchestration/index.js";
import { renderWorkspacePlan } from "./planning/render-workspace-plan.js";
import { createRepos } from "./repos/index.js";
import { openSqliteDatabase } from "./repos/impl/sqlite-database.js";
import { createReviewService, resolveGitHubAuthEnv } from "./review/index.js";
import { createSelfRebootScheduler, runRebootSidecar } from "./system/reboot.js";
import { createTaskSystem } from "./tasking/index.js";
import { discoverGitRepos } from "./workspace/git-repo-discovery.js";
import { initializeWorkspace, loadWorkspace } from "./workspace/index.js";
import { harvestTraces } from "./eval/harvest.js";
import { evalPromptNames } from "./eval/registry.js";
import { formatEvalReport, runEval } from "./eval/run.js";
import { isRunnerProvider, runnerProviders, type RunnerProvider } from "./domain/index.js";
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

const collectWorkerResultActions = (value: string, previous: WorkerResultAction[] = []): WorkerResultAction[] => [
  ...previous,
  parseWorkerResultAction(value),
];

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

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const withWorkspaceRepos = async <T>(
  workspace: string,
  handler: (repos: ReturnType<typeof createRepos>, paths: Awaited<ReturnType<typeof loadWorkspace>>["paths"]) => Promise<T>,
): Promise<T> => {
  const { paths } = await loadWorkspace(workspace);
  const repos = createRepos(await openSqliteDatabase(paths.dbPath));
  try {
    await repos.migrationRunner.runMigrations(paths.projectRoot);
    return await handler(repos, paths);
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

const agentResult = program.command("agent-result").description("Validate agent result output");

agentResult
  .command("validate")
  .description("Validate raw JSON or a complete <agent-result> block from stdin")
  .requiredOption("--action <action>", "Expected worker action", parseWorkerResultAction)
  .addHelpText("after", () => renderAgentResultSchemaHelp(resolveHelpAction()))
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

const parseRunnerProvider = (value: string): RunnerProvider => {
  if (!isRunnerProvider(value)) {
    throw new InvalidArgumentError(`Runner must be one of: ${runnerProviders.join(", ")}`);
  }
  return value;
};

program
  .command("eval")
  .description("Run a behavioral eval for a prompt against a live runner (opt-in; costs tokens, non-deterministic)")
  .argument("<prompt>", `Prompt to evaluate (one of: ${evalPromptNames.join(", ")})`)
  .option("--samples <count>", "Samples per case", parsePositiveInteger, 3)
  .option("--runner <provider>", `Runner provider (${runnerProviders.join("|")}); defaults to the workspace default`, parseRunnerProvider)
  .option("--model <model>", "Override the runner model")
  .option("--case <id>", "Run only the case with this id")
  .option("--timeout <ms>", "Per-sample timeout in milliseconds", parsePositiveInteger, 300_000)
  .option("--no-judge", "Skip the LLM-as-judge quality grader (deterministic graders only)")
  .option("--show-output", "Print each sample's raw runner stdout to stderr (debugging)")
  .option("--json", "Emit the JSON report instead of the human-readable summary")
  .action(
    async (
      prompt: string,
      options: { samples: number; runner?: RunnerProvider; model?: string; case?: string; timeout: number; judge: boolean; showOutput?: boolean; json?: boolean },
    ) => {
      if (!evalPromptNames.includes(prompt)) {
        process.stderr.write(`Unknown prompt "${prompt}". Known: ${evalPromptNames.join(", ")}\n`);
        process.exitCode = 1;
        return;
      }

      try {
        const report = await runEval({
          prompt,
          samplesPerCase: options.samples,
          timeoutMs: options.timeout,
          judge: options.judge,
          ...(options.runner ? { runner: options.runner } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.case ? { caseId: options.case } : {}),
          ...(options.showOutput ? { showOutput: true } : {}),
        });

        if (options.json) {
          writeJson(report);
        } else {
          process.stdout.write(`${formatEvalReport(report)}\n`);
        }
      } catch (error) {
        process.stderr.write(`eval failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

program
  .command("eval-harvest")
  .description("Harvest (rendered prompt, worker result) pairs from a workspace's retained attempt artifacts, for eval corpus building")
  .argument("<workspace>")
  .option("--action <action>", "Restrict to a worker action (repeatable)", collectWorkerResultActions, [])
  .option("--limit <count>", "Max attempts to scan, most recent first", parsePositiveInteger, 500)
  .option("--summary-only", "Emit only the harvest summary counts, not the harvested traces")
  .action(async (workspace: string, options: { action: WorkerResultAction[]; limit: number; summaryOnly?: boolean }) => {
    await withWorkspaceRepos(workspace, async (repos, paths) => {
      const actions = options.action.length > 0 ? new Set(options.action) : undefined;
      const { traces, summary } = await harvestTraces({
        attempts: repos.attempts,
        artifacts: repos.artifacts,
        workspaceRoot: paths.workspaceRoot,
        limit: options.limit,
        ...(actions ? { actions } : {}),
      });
      writeJson({ workspace, actions: options.action, summary, ...(options.summaryOnly ? {} : { traces }) });
    });
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
