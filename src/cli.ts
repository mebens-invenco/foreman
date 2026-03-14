#!/usr/bin/env node

import { Command } from "commander";

import { loadWorkspaceConfig } from "./config.js";
import { applyMigrations, ForemanDb, openDatabase } from "./db.js";
import { createHttpServer } from "./http.js";
import { GitHubReviewService, resolveGitHubAuthEnv } from "./review.js";
import { discoverRepos } from "./repos.js";
import { OpenCodeRunner } from "./runner.js";
import { SchedulerService } from "./scheduler.js";
import { createTaskSystem } from "./task-system.js";
import { importLegacyMemory, initializeWorkspace, renderWorkspacePlan } from "./workspace.js";

const program = new Command();

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
  .action(async (workspace: string) => {
    const { config, paths, env } = await loadWorkspaceConfig(workspace);
    const resolvedEnv = await resolveGitHubAuthEnv(env);
    const db = new ForemanDb(await openDatabase(paths.dbPath));
    await applyMigrations(db.sqlite, paths.projectRoot);
    const repos = await discoverRepos(config, paths);
    const taskSystem = createTaskSystem({ config, paths, env: resolvedEnv });
    await taskSystem.validateStartup?.();
    await renderWorkspacePlan(workspace, db);

    const scheduler = new SchedulerService({
      config,
      paths,
      db,
      taskSystem,
      reviewService: new GitHubReviewService(resolvedEnv),
      runner: new OpenCodeRunner(config.runner.model, config.runner.variant),
      repos,
      env: resolvedEnv,
    });

    const server = createHttpServer({ config, paths, repos, db, taskSystem, scheduler });
    await server.listen({ host: config.http.host, port: config.http.port });
    scheduler.start();

    process.stdout.write(`Foreman serving workspace ${workspace} on http://${config.http.host}:${config.http.port}\n`);

    const shutdown = async (): Promise<void> => {
      await scheduler.stop();
      await server.close();
      db.close();
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

const plan = program.command("plan");
plan
  .command("prompt")
  .argument("<workspace>")
  .action(async (workspace: string) => {
    const { paths } = await loadWorkspaceConfig(workspace);
    const db = new ForemanDb(await openDatabase(paths.dbPath));
    try {
      await applyMigrations(db.sqlite, paths.projectRoot);
      const result = await renderWorkspacePlan(workspace, db);
      process.stdout.write(`Rendered plan prompt to ${result.paths.planPath}\n`);
    } finally {
      db.close();
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
