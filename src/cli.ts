#!/usr/bin/env node

import path from "node:path";

import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";

import {
  proposeConfidenceTransitions,
  USAGE_EPOCH,
  type LifecycleProposal,
} from "./curation/confidence-lifecycle.js";
import { consolidateLearnings, type ConsolidationReport } from "./curation/consolidate-learnings.js";
import type { ConsolidationCluster } from "./curation/consolidation-scan.js";
import { backfillLearningEmbeddings } from "./embeddings/backfill-learning-embeddings.js";
import { createEmbedder } from "./embeddings/create-embedder.js";
import { listRunnerRates } from "./execution/cost/rates.js";
import {
  isUsageGroupBy,
  rollupUsage,
  usageGroupByValues,
  type UsageBucket,
  type UsageGroupBy,
} from "./execution/cost/usage-rollup.js";
import { readAttemptProvenanceEnv } from "./execution/attempt-provenance-env.js";
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
import type { LearningInjectionStats, LearningSearchEventInput, LearningUsageStats } from "./repos/index.js";
import { openSqliteDatabase } from "./repos/impl/sqlite-database.js";
import { searchLearningsWithHybridFallback } from "./retrieval/hybrid-learning-search.js";
import { createReviewService, resolveGitHubAuthEnv } from "./review/index.js";
import { createSelfRebootScheduler, runRebootSidecar } from "./system/reboot.js";
import { createTaskSystem } from "./tasking/index.js";
import { discoverGitRepos } from "./workspace/git-repo-discovery.js";
import { findProjectRoot, initializeWorkspace, loadWorkspace } from "./workspace/index.js";
import { harvestTraces } from "./eval/harvest.js";
import { evalPromptNames } from "./eval/registry.js";
import { formatEvalReport, runEval } from "./eval/run.js";
import { formatRetrievalReport, runRetrievalBench } from "./eval/retrieval/run.js";
import { isRunnerProvider, runnerProviders, type RunnerProvider } from "./domain/index.js";
import type { LoggerLevelName } from "./logger.js";

const cliArgv =
  process.argv[2] === "--" ? [process.argv[0]!, process.argv[1]!, ...process.argv.slice(3)] : process.argv;
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
  const actionArgIndex = cliArgv.findIndex((arg) => arg === "--action" || arg.startsWith("--action="));
  const value = cliArgv[actionArgIndex]?.startsWith("--action=")
    ? cliArgv[actionArgIndex]!.slice("--action=".length)
    : cliArgv[actionArgIndex + 1];

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

// Read-only variant for commands that inspect a workspace a live server may
// own (e.g. eval-harvest): opens the DB readonly (no create, no journal-mode
// switch, no write locks) and REFUSES on pending migrations instead of
// applying them under the running server.
const withWorkspaceReposReadOnly = async <T>(
  workspace: string,
  handler: (repos: ReturnType<typeof createRepos>, paths: Awaited<ReturnType<typeof loadWorkspace>>["paths"]) => Promise<T>,
): Promise<T> => {
  const { paths } = await loadWorkspace(workspace);
  const repos = createRepos(await openSqliteDatabase(paths.dbPath, { readonly: true }));
  try {
    await repos.migrationRunner.assertMigrationsCurrent(paths.projectRoot);
    return await handler(repos, paths);
  } finally {
    repos.close();
  }
};

// Telemetry for learning retrieval must never fail the underlying query: record
// the event best-effort and swallow (log to stderr, keeping stdout clean JSON)
// any error so the search/get result still returns.
//
// The attempt is read from the env the executor exported, never from a flag: an
// agent able to name its own attempt could name someone else's, and a
// distinct-task count is only worth having if a task cannot inflate it. Ad-hoc
// human use has no such env and stamps NULL.
const recordLearningSearchEvent = (repos: ReturnType<typeof createRepos>, input: LearningSearchEventInput): void => {
  const source = readAttemptProvenanceEnv(process.env);
  try {
    repos.learningSearchEvents.recordEvent({ ...input, ...(source ? { source } : {}) });
  } catch (error) {
    process.stderr.write(
      `warning: failed to record learning ${input.kind} telemetry: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

const formatRate = (value: number): string => `${(value * 100).toFixed(1)}%`;

const renderInjectionStats = (input: { since: string | undefined; stats: LearningInjectionStats }): string => {
  const { stats } = input;
  const metrics = [
    ["Attempts eligible", formatUsageNumber(stats.eligibleAttempts), ""],
    ["Attempts with injection", formatUsageNumber(stats.attemptsWithInjection), formatRate(stats.attemptsWithInjectionRate)],
    ["Learnings injected", formatUsageNumber(stats.injectedLearnings), ""],
    ["Learnings applied", formatUsageNumber(stats.appliedLearnings), formatRate(stats.hitRate)],
  ];
  const metricWidths = [0, 1, 2].map((index) => Math.max(...metrics.map((row) => row[index]?.length ?? 0)));

  const lines = [
    `Learning injection ${input.since ? `since ${input.since}` : "(all time)"}, over execution/retry/review attempts:`,
    ...metrics.map((row) => row.map((cell, index) => padCell(cell, metricWidths[index]!)).join("  ").trimEnd()),
  ];

  if (stats.topAppliedLearnings.length > 0) {
    const header = ["Applied", "Injected", "Learning", "Title"];
    const rows = stats.topAppliedLearnings.map((learning) => [
      formatUsageNumber(learning.appliedCount),
      formatUsageNumber(learning.injectedCount),
      learning.learningId,
      learning.title,
    ]);
    const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)));

    lines.push(
      "",
      "Top applied learnings:",
      header.map((cell, index) => padCell(cell, widths[index]!)).join("  ").trimEnd(),
      widths.map((width) => "-".repeat(width)).join("  "),
      ...rows.map((row) => row.map((cell, index) => padCell(cell, widths[index]!)).join("  ").trimEnd()),
    );
  }

  return lines.join("\n");
};

/**
 * The raw counters sit next to the corrected ones on purpose. `Reads` / `Applies`
 * are pipeline touches — a task whose execution, review and reviewer stages each
 * search bumps them three times for one learning — and the gap between them and
 * the `Tasks` columns is the inflation this table exists to expose. `Echo` is the
 * learning's own source task using it, excluded from the task counts and shown so
 * the exclusion is visible rather than silent.
 */
const renderUsageStats = (input: { since: string | undefined; stats: LearningUsageStats }): string => {
  const { stats } = input;
  const lines = [
    `Task-distinct learning usage ${input.since ? `since ${input.since}` : "(all time)"}:`,
    `Unattributed read events (ad-hoc CLI, no attempt — excluded): ${formatUsageNumber(stats.unattributedReadEvents)}`,
  ];

  if (stats.learnings.length === 0) {
    lines.push("", "No learning has been read or applied inside a task attempt yet.");
    return lines.join("\n");
  }

  const header = ["Tasks read", "Tasks applied", "Reads", "Applies", "Echo r/a", "Learning", "Title"];
  const rows = stats.learnings.map((learning) => [
    formatUsageNumber(learning.distinctTasksRead),
    formatUsageNumber(learning.distinctTasksApplied),
    formatUsageNumber(learning.readCount),
    formatUsageNumber(learning.appliedCount),
    `${formatUsageNumber(learning.selfEchoReads)}/${formatUsageNumber(learning.selfEchoApplies)}`,
    learning.learningId,
    learning.title,
  ]);
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)));

  lines.push(
    "",
    header.map((cell, index) => padCell(cell, widths[index]!)).join("  ").trimEnd(),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => row.map((cell, index) => padCell(cell, widths[index]!)).join("  ").trimEnd()),
  );

  return lines.join("\n");
};

const survivorReasonLabel = (cluster: ConsolidationCluster): string => {
  const applies = formatUsageNumber(cluster.members[0]!.distinctTasksApplied);
  return cluster.survivorReason === "distinct_tasks_applied"
    ? `most distinct-task applies: ${applies}`
    : `most recent update; applies tied at ${applies}`;
};

const renderConsolidationReport = (input: { report: ConsolidationReport }): string => {
  const { report } = input;
  const coverage = `scanned ${formatUsageNumber(report.scanned)} of ${formatUsageNumber(report.corpus)} learnings`;
  const header = `Learning consolidation (threshold ${report.threshold}), ${report.applied ? "applied" : "dry run"} — ${coverage}:`;
  if (report.clusters.length === 0) {
    // Scanned nothing over a non-empty corpus is a coverage gap, not an all-clear:
    // the stored vectors do not match the workspace embedder model.
    const note =
      report.scanned === 0 && report.corpus > 0
        ? "\nNo current embeddings for the workspace model — run `foreman learnings backfill-embeddings` first."
        : "";
    return `${header}\nNo near-duplicate clusters found.${note}`;
  }

  const loserCount = report.clusters.reduce((total, cluster) => total + cluster.loserIds.length, 0);
  const lines = [
    `${header} ${report.clusters.length} cluster(s), ${loserCount} loser(s)${report.applied ? " archived" : " to archive"}.`,
  ];

  report.clusters.forEach((cluster, index) => {
    lines.push("", `Cluster ${index + 1} — survivor ${cluster.survivorId} (${survivorReasonLabel(cluster)})`);
    for (const member of cluster.members) {
      const role = member.id === cluster.survivorId ? "survivor" : "loser";
      lines.push(
        `  ${padCell(role, 8)} ${member.id}  repo=${member.repo}  applies=${formatUsageNumber(member.distinctTasksApplied)}  updated=${member.updatedAt}  ${member.title}`,
      );
    }
    for (const pair of cluster.pairwiseSimilarities) {
      lines.push(`    ${pair.left} ~ ${pair.right}  ${pair.similarity.toFixed(4)}`);
    }
  });

  return lines.join("\n");
};

/**
 * The proposal table for `learnings curate`. Every row carries the evidence it
 * fired on — the distinct-task count for a promotion, the age/idle days for a
 * decay — so a reader can see WHY each transition is proposed, not just that it
 * is. The header line says whether these changes were applied or are a dry run.
 */
const renderCurationProposals = (input: { applied: boolean; proposals: LifecycleProposal[] }): string => {
  const { applied, proposals } = input;
  if (proposals.length === 0) {
    return applied
      ? "Confidence curation: applied no changes; no learning met a promotion or decay threshold."
      : "Confidence curation (dry run): no learning met a promotion or decay threshold. Pass --apply to execute.";
  }

  const header = ["Action", "From", "To", "Distinct applied", "Learning", "Reason", "Title"];
  const rows = proposals.map((proposal) =>
    proposal.kind === "promote"
      ? [
          "promote",
          proposal.from,
          proposal.to,
          formatUsageNumber(proposal.distinctTasksApplied),
          proposal.learningId,
          proposal.reason,
          proposal.title,
        ]
      : ["archive", proposal.from, "archived", "-", proposal.learningId, proposal.reason, proposal.title],
  );
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)));

  return [
    applied
      ? "Confidence curation — applied:"
      : "Confidence curation — dry run (pass --apply to execute):",
    header.map((cell, index) => padCell(cell, widths[index]!)).join("  ").trimEnd(),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => row.map((cell, index) => padCell(cell, widths[index]!)).join("  ").trimEnd()),
  ].join("\n");
};

/**
 * A confidence-only update leaves the embedding valid — it is keyed on the
 * title/content snapshot, not `updated_at` — so promotion never strands a vector.
 * Decay archives through the same soft-archive substrate a worker `archive` uses.
 */
const applyLifecycleProposals = (repos: ReturnType<typeof createRepos>, proposals: LifecycleProposal[]): void => {
  for (const proposal of proposals) {
    if (proposal.kind === "promote") {
      repos.learnings.updateLearning({ id: proposal.learningId, confidence: proposal.to });
    } else {
      repos.learnings.archiveLearning(proposal.learningId);
    }
  }
};

const parseIsoInstant = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentError("Value must be an ISO-8601 date or timestamp.");
  }

  // Normalized, because the column it is compared against holds ISO instants and
  // the comparison is a string one.
  return parsed.toISOString();
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
      embedder: createEmbedder(paths.projectRoot),
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
  .option("--caller <stage>", "Optional pipeline stage recorded in retrieval telemetry")
  .action(async (workspace: string, options: { repo: string[]; query: string[]; limit: number; caller?: string }) => {
    if (options.query.length === 0) {
      throw new InvalidArgumentError("At least one --query is required.");
    }

    await withWorkspaceRepos(workspace, async (repos, paths) => {
      const { pipeline, learnings } = await searchLearningsWithHybridFallback(
        {
          learnings: repos.learnings,
          embedder: createEmbedder(paths.projectRoot),
          warn: (message) => process.stderr.write(`warning: ${message}\n`),
        },
        {
          queries: options.query,
          ...(options.repo.length > 0 ? { repos: options.repo } : {}),
          limit: options.limit,
        },
      );

      recordLearningSearchEvent(repos, {
        kind: "search",
        caller: options.caller ?? null,
        queries: options.query,
        repos: options.repo,
        hitIds: learnings.map((learning) => learning.id),
        hitScores: learnings.map((learning) => learning.score),
        pipeline,
      });

      // `pipeline` rides on stdout because `score` inverts across the fallback
      // boundary, and consumers that read this JSON do not see the stderr warning.
      writeJson({
        workspace,
        repos: options.repo,
        queries: options.query,
        pipeline,
        learnings,
      });
    });
  });

learnings
  .command("get")
  .argument("<workspace>")
  .requiredOption("--id <id>", "Learning id to fetch", collectRepeatedValues, [])
  .option("--caller <stage>", "Optional pipeline stage recorded in retrieval telemetry")
  .action(async (workspace: string, options: { id: string[]; caller?: string }) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      const learnings = repos.learnings.getLearningsByIds(options.id, { incrementReadCount: true });
      const foundIds = new Set(learnings.map((learning) => learning.id));

      recordLearningSearchEvent(repos, {
        kind: "get",
        caller: options.caller ?? null,
        requestedIds: options.id,
        hitIds: learnings.map((learning) => learning.id),
      });

      writeJson({
        workspace,
        ids: options.id,
        learnings,
        missingIds: options.id.filter((id) => !foundIds.has(id)),
      });
    });
  });

learnings
  .command("archive")
  .description("Soft-archive a learning so it leaves every retrieval surface but stays in the store")
  .argument("<workspace>")
  .argument("<id>")
  .action(async (workspace: string, id: string) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      repos.learnings.archiveLearning(id);
      const [learning] = repos.learnings.getLearningsByIds([id]);
      writeJson({ workspace, id, archived: true, learning });
    });
  });

learnings
  .command("unarchive")
  .description("Restore a soft-archived learning to every retrieval surface")
  .argument("<workspace>")
  .argument("<id>")
  .action(async (workspace: string, id: string) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      repos.learnings.unarchiveLearning(id);
      const [learning] = repos.learnings.getLearningsByIds([id]);
      writeJson({ workspace, id, archived: false, learning });
    });
  });

learnings
  .command("backfill-embeddings")
  .description("Embed learnings whose vector is missing or stale for the current embedding model")
  .argument("<workspace>")
  .action(async (workspace: string) => {
    await withWorkspaceRepos(workspace, async (repos, paths) => {
      const result = await backfillLearningEmbeddings({
        learnings: repos.learnings,
        embedder: createEmbedder(paths.projectRoot),
      });

      writeJson({ workspace, ...result });
    });
  });

learnings
  .command("injection-stats")
  .description("Report how often injected learnings are pushed into attempts, and how often an attempt then applies one")
  .argument("<workspace>")
  .option("--since <iso>", "Count only attempts started at or after this ISO date/timestamp", parseIsoInstant)
  .option("--json", "Emit JSON instead of the tab-aligned table")
  .action(async (workspace: string, options: { since?: string; json?: boolean }) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      const stats = repos.learningInjectionEvents.getInjectionStats({
        ...(options.since !== undefined ? { since: options.since } : {}),
      });

      if (options.json) {
        writeJson({ workspace, since: options.since ?? null, ...stats });
        return;
      }

      process.stdout.write(`${renderInjectionStats({ since: options.since, stats })}\n`);
    });
  });

learnings
  .command("usage-stats")
  .description("Report per-learning usage by DISTINCT task, with the learning's own source task excluded")
  .argument("<workspace>")
  .option("--since <iso>", "Count only usage events recorded at or after this ISO date/timestamp", parseIsoInstant)
  .option("--limit <count>", "Maximum learnings to list", parsePositiveInteger, 20)
  .option("--json", "Emit JSON instead of the tab-aligned table")
  .action(async (workspace: string, options: { since?: string; limit: number; json?: boolean }) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      const stats = repos.learningUsage.getUsageStats({
        ...(options.since !== undefined ? { since: options.since } : {}),
        topLimit: options.limit,
      });

      if (options.json) {
        writeJson({ workspace, since: options.since ?? null, ...stats });
        return;
      }

      process.stdout.write(`${renderUsageStats({ since: options.since, stats })}\n`);
    });
  });

learnings
  .command("consolidate")
  .description("Scan current learnings for near-duplicate clusters; --apply archives the losers with duplicate_of set")
  .argument("<workspace>")
  .option("--apply", "Archive each cluster's losers and set duplicate_of on them (dry-run by default)")
  .option("--json", "Emit JSON instead of the human-readable report")
  .action(async (workspace: string, options: { apply?: boolean; json?: boolean }) => {
    await withWorkspaceRepos(workspace, async (repos, paths) => {
      // The embedder is constructed only to name the vector space to scan; it is
      // never asked to embed, so this stays hermetic (no model download).
      const report = consolidateLearnings(
        {
          learnings: repos.learnings,
          learningUsage: repos.learningUsage,
          model: createEmbedder(paths.projectRoot).modelId,
        },
        { apply: options.apply ?? false },
      );

      if (options.json) {
        writeJson({ workspace, ...report });
        return;
      }

      process.stdout.write(`${renderConsolidationReport({ report })}\n`);
    });
  });

learnings
  .command("curate")
  .description("Promote learnings on distinct-task usage and archive decayed emerging ones (dry run unless --apply)")
  .argument("<workspace>")
  .option("--apply", "Execute the proposed transitions; without it the command only prints them")
  .option("--json", "Emit JSON instead of the tab-aligned table")
  .action(async (workspace: string, options: { apply?: boolean; json?: boolean }) => {
    await withWorkspaceRepos(workspace, async (repos) => {
      const proposals = proposeConfidenceTransitions(
        repos.learningUsage.getLifecycleRollups(),
        new Date(),
        new Date(USAGE_EPOCH),
      );

      const applied = options.apply === true;
      if (applied) {
        applyLifecycleProposals(repos, proposals);
      }

      if (options.json) {
        writeJson({ workspace, applied, proposals });
        return;
      }

      process.stdout.write(`${renderCurationProposals({ applied, proposals })}\n`);
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

const evalCommand = program
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

evalCommand
  .command("retrieval")
  .description("Run the offline retrieval bench over committed fixtures (deterministic; no workspace or runner)")
  .option("--json", "Emit the metrics objects as JSON")
  .action(async (_options: { json?: boolean }, command: Command) => {
    try {
      const projectRoot = await findProjectRoot();
      const result = await runRetrievalBench({ projectRoot, embedder: createEmbedder(projectRoot) });
      // The parent `eval` command also declares `--json`, so the flag binds to the
      // parent; read it via optsWithGlobals rather than this subcommand's own opts.
      if (command.optsWithGlobals().json) {
        writeJson({ model: result.model, fts: result.fts.metrics, hybrid: result.hybrid.metrics });
      } else {
        process.stdout.write(`${formatRetrievalReport(result)}\n`);
      }
    } catch (error) {
      process.stderr.write(`retrieval bench failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("eval-harvest")
  .description("Harvest (rendered prompt, worker result) pairs from a workspace's retained attempt artifacts, for eval corpus building")
  .argument("<workspace>")
  .option("--action <action>", "Restrict to a worker action (repeatable)", collectWorkerResultActions, [])
  .option("--limit <count>", "Max attempts to scan, most recent first", parsePositiveInteger, 500)
  .option("--summary-only", "Emit only the harvest summary counts, not the harvested traces")
  .action(async (workspace: string, options: { action: WorkerResultAction[]; limit: number; summaryOnly?: boolean }) => {
    await withWorkspaceReposReadOnly(workspace, async (repos, paths) => {
      const actions = options.action.length > 0 ? new Set(options.action) : undefined;
      const { traces, summary } = await harvestTraces({
        attempts: repos.attempts,
        artifacts: repos.artifacts,
        workspaceRoot: paths.workspaceRoot,
        limit: options.limit,
        ...(actions ? { actions } : {}),
        ...(options.summaryOnly ? { summaryOnly: true } : {}),
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

await program.parseAsync(cliArgv);
