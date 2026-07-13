import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { priorityToRank, type ActionType, type Task } from "../domain/index.js";
import { createRepos, type AttemptRecord, type ForemanRepos } from "../repos/index.js";
import { openSqliteDatabase, type SqliteForemanDatabase } from "../repos/impl/sqlite-database.js";
import { createDefaultWorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

export const testProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const createTempDir = async (prefix: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), prefix));

export interface FakeRunnerBin {
  /**
   * Create a temp dir, write the fake-binary script into it with mode 0o755,
   * point the runner's FOREMAN_*_BIN env var at it, and return the temp dir.
   * The dir is tracked for automatic removal by `cleanup()`.
   */
  setUp: () => Promise<string>;
  /**
   * Restore the original FOREMAN_*_BIN value and remove every dir created by
   * `setUp()`. Call from the test file's `afterEach`.
   */
  cleanup: () => Promise<void>;
}

/**
 * De-duplicates the fake-runner-binary plumbing shared across the per-runner
 * test files: writing an executable script, save/restore of the runner's
 * FOREMAN_*_BIN env var, and temp-dir cleanup. The script contents and the
 * env var differ per runner and are supplied by the caller.
 */
export const createFakeRunnerBin = (options: {
  envVar: string;
  script: string;
  scriptName: string;
  prefix?: string;
}): FakeRunnerBin => {
  const { envVar, script, scriptName, prefix = "foreman-runner-test-" } = options;
  const cleanupDirs: string[] = [];
  const originalBin = process.env[envVar];

  return {
    setUp: async () => {
      const tempDir = await createTempDir(prefix);
      cleanupDirs.push(tempDir);
      const scriptPath = path.join(tempDir, scriptName);
      await fs.writeFile(scriptPath, script, { mode: 0o755 });
      process.env[envVar] = scriptPath;
      return tempDir;
    },
    cleanup: async () => {
      if (originalBin === undefined) {
        delete process.env[envVar];
      } else {
        process.env[envVar] = originalBin;
      }
      await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    },
  };
};

export const createWorkspacePaths = (projectRoot: string, workspaceRoot: string): WorkspacePaths => ({
  projectRoot,
  workspaceRoot,
  configPath: path.join(workspaceRoot, "foreman.workspace.yml"),
  envPath: path.join(workspaceRoot, ".env"),
  dbPath: path.join(workspaceRoot, "foreman.db"),
  logsDir: path.join(workspaceRoot, "logs"),
  attemptsLogDir: path.join(workspaceRoot, "logs", "attempts"),
  artifactsDir: path.join(workspaceRoot, "artifacts"),
  worktreesDir: path.join(workspaceRoot, "worktrees"),
  tasksDir: path.join(workspaceRoot, "tasks"),
  planPath: path.join(workspaceRoot, "plan.md"),
});

export const createMigratedDb = async (
  dbPath: string,
  projectRoot: string,
): Promise<ForemanRepos & { database: SqliteForemanDatabase }> => {
  const repos = createRepos(await openSqliteDatabase(dbPath));
  await repos.migrationRunner.runMigrations(projectRoot);
  return repos as ForemanRepos & { database: SqliteForemanDatabase };
};

export const createTestConfig = () => createDefaultWorkspaceConfig("test-workspace", "file");

/**
 * A real `execution_attempt` row, with the task target and job it hangs off.
 *
 * `learning_injection_event.attempt_id` is a foreign key, so a telemetry fixture
 * cannot hand injection a synthetic attempt id: the insert would be rejected, and
 * the never-fail catch around it would swallow the rejection into a warning.
 */
export const seedExecutionAttempt = (
  repos: ForemanRepos,
  input: { task: Task; repoKey: string; action: ActionType },
): AttemptRecord => {
  repos.workers.ensureWorkerSlots(1);
  repos.taskMirror.saveTasks([input.task]);
  const target = repos.taskMirror.getTaskTarget(input.task.id, input.repoKey);
  if (!target) {
    throw new Error(`seedExecutionAttempt: task ${input.task.id} carries no target for repo ${input.repoKey}`);
  }

  const job = repos.jobs.createJob({
    taskId: input.task.id,
    taskTargetId: target.id,
    taskProvider: input.task.provider,
    action: input.action,
    priorityRank: priorityToRank(input.task.priority),
    repoKey: input.repoKey,
    baseBranch: "master",
    dedupeKey: `${input.task.id}:${input.repoKey}:${input.action}`,
    selectionReason: "test fixture",
  });

  return repos.attempts.createAttempt({
    jobId: job.id,
    workerId: repos.workers.listWorkers()[0]!.id,
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    runnerVariant: "high",
  });
};
