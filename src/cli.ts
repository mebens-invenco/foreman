#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";

import { importLegacyMemory } from "./importing/import-legacy-memory.js";
import { createAgentRunner } from "./execution/index.js";
import { createHttpServer } from "./http.js";
import { LoggerService } from "./logger.js";
import { SchedulerService } from "./orchestration/index.js";
import { renderWorkspacePlan } from "./planning/render-workspace-plan.js";
import { createRepos } from "./repos/index.js";
import { openSqliteDatabase } from "./repos/impl/sqlite-database.js";
import { createReviewService, resolveGitHubAuthEnv } from "./review/index.js";
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

const parseLogLevel = (value: string): LoggerLevelName => {
  const normalized = value.toLowerCase();
  if (!logLevels.includes(normalized as LoggerLevelName)) {
    throw new InvalidArgumentError(`Log level must be one of: ${logLevels.join(", ")}`);
  }

  return normalized as LoggerLevelName;
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
      runner: createAgentRunner({ config }),
      repos: repoRefs,
      env: resolvedEnv,
      logger: logger.child({ component: "scheduler" }),
    });

    const server = createHttpServer({ config, paths, repoRefs, repos, taskSystem, reviewService, scheduler });
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

const db = program.command("db");
db
  .command("import-legacy")
  .argument("<workspace>")
  .argument("<legacy-memory-db>")
  .action(async (workspace: string, legacyMemoryDb: string) => {
    await importLegacyMemory(workspace, legacyMemoryDb);
    process.stdout.write(`Imported legacy memory from ${legacyMemoryDb}\n`);
  });

await program.parseAsync(process.argv);
