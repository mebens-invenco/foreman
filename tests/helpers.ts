import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import Database from "better-sqlite3";

import { createDefaultWorkspaceConfig, type WorkspacePaths } from "../src/config.js";
import { createRepos, type ForemanRepos } from "../src/repos/index.js";
import { openSqliteDatabase, type SqliteForemanDatabase } from "../src/repos/impl/sqlite-database.js";

export const createTempDir = async (prefix: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), prefix));

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

export const createLegacyMemoryDb = (dbPath: string): void => {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE history_step (
      step_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      stage TEXT NOT NULL,
      issue TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE TABLE history_step_repo (
      step_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      path TEXT NOT NULL,
      before_sha TEXT NOT NULL,
      after_sha TEXT NOT NULL,
      PRIMARY KEY (step_id, position)
    );
    CREATE TABLE learning (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      repo TEXT NOT NULL,
      tags TEXT NOT NULL,
      confidence TEXT NOT NULL,
      content TEXT NOT NULL,
      applied_count INTEGER NOT NULL DEFAULT 0,
      read_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.prepare(
    "INSERT INTO learning(id, title, repo, tags, confidence, content, applied_count, read_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "learn-1",
    "Prefer repo fixtures",
    "product-app",
    JSON.stringify(["tests"]),
    "established",
    "Use fixtures over hand-built objects.",
    1,
    2,
    "2026-03-14T12:00:00Z",
    "2026-03-14T12:00:00Z",
  );

  db.prepare("INSERT INTO history_step(step_id, created_at, stage, issue, summary) VALUES (?, ?, ?, ?, ?)").run(
    "step-1",
    "2026-03-14T12:00:00Z",
    "execution",
    "eng-1",
    "Implemented the task.",
  );
  db.prepare(
    "INSERT INTO history_step_repo(step_id, position, path, before_sha, after_sha) VALUES (?, ?, ?, ?, ?)",
  ).run("step-1", 1, "/repos/product-app", "abc", "def");
  db.close();
};

export const createTestConfig = () => createDefaultWorkspaceConfig("test-workspace", "file");
