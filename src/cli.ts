#!/usr/bin/env node

import { Command, InvalidArgumentError } from "commander";

import { loadWorkspaceConfig } from "./config.js";
import { applyMigrations, ForemanDb, openDatabase } from "./db.js";
import { createHttpServer } from "./http.js";
import { LoggerService } from "./logger.js";
import { GitHubReviewService, resolveGitHubAuthEnv } from "./review.js";
import { discoverRepos } from "./repos.js";
import { OpenCodeRunner } from "./runner.js";
import { SchedulerService } from "./scheduler.js";
import { createTaskSystem } from "./task-system.js";
import { importLegacyMemory, initializeWorkspace, renderWorkspacePlan } from "./workspace.js";
import type { LoggerLevelName } from "./logger.js";

const program = new Command();
const logLevels = ["debug", "info", "warn", "error"] as const satisfies readonly LoggerLevelName[];

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
    const { config, paths, env } = await loadWorkspaceConfig(workspace);
    const logger = LoggerService.create({
      paths,
      context: { workspace: config.workspace.name, component: "cli.serve" },
      minLevel: options.logLevel,
    });
    logger.info("starting foreman service", { host: config.http.host, port: config.http.port });
    const resolvedEnv = await resolveGitHubAuthEnv(env, logger.child({ component: "review.github.auth" }));
    const db = new ForemanDb(await openDatabase(paths.dbPath));
    await applyMigrations(db.sqlite, paths.projectRoot);
    const repos = await discoverRepos(config, paths);
    logger.info("discovered repositories for service startup", { repoCount: repos.length });
    const taskSystem = createTaskSystem({
      config,
      paths,
      env: resolvedEnv,
      logger: logger.child({ component: "taskSystem" }),
    });
    await taskSystem.validateStartup?.();
    logger.info("validated task system startup");
    await renderWorkspacePlan(workspace, db, logger);

    const scheduler = new SchedulerService({
      config,
      paths,
      db,
      taskSystem,
      reviewService: new GitHubReviewService(resolvedEnv, logger.child({ component: "review.github" })),
      runner: new OpenCodeRunner(config.runner.model, config.runner.variant),
      repos,
      env: resolvedEnv,
      logger: logger.child({ component: "scheduler" }),
    });

    const server = createHttpServer({ config, paths, repos, db, taskSystem, scheduler });
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
        db.close();
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
    const { paths } = await loadWorkspaceConfig(workspace);
    const logger = LoggerService.create({
      paths,
      context: { workspace, component: "cli.plan" },
      minLevel: options.logLevel,
    });
    logger.info("rendering plan prompt from cli command");
    const db = new ForemanDb(await openDatabase(paths.dbPath));
    try {
      await applyMigrations(db.sqlite, paths.projectRoot);
      const result = await renderWorkspacePlan(workspace, db, logger);
      logger.info("rendered plan prompt from cli command", { planPath: result.paths.planPath, contextPath: result.contextPath });
      process.stdout.write(`Rendered plan prompt to ${result.paths.planPath}\n`);
    } finally {
      db.close();
      await logger.flush();
    }
  });

const scheduler = program.command("scheduler");
for (const action of ["start", "pause", "stop"] as const) {
  scheduler.command(action).argument("<workspace>").action(async (workspace: string) => {
    const { config } = await loadWorkspaceConfig(workspace);
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
