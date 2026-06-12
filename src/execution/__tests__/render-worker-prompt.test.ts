import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Task } from "../../domain/index.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import type { WorkspacePaths } from "../../workspace/workspace-paths.js";
import { renderWorkerPrompt, type WorkerPromptPullRequestReference } from "../render-worker-prompt.js";

// The priorCheckpoint override seam: a pre-resolved checkpoint renders in place
// of the foremanRepos-resolved context (the eval harness injects a synthetic
// checkpoint with no repos backing it), while the no-override path keeps the
// placeholder. Rendered against the real reviewer templates on disk.

const task: Task = {
  id: "EVAL-RWP1",
  provider: "file",
  providerId: "EVAL-RWP1",
  title: "Review: render test",
  description: "Render-test task.",
  state: "ready",
  providerState: "ready",
  priority: "high",
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: "eval-repo", branchName: "eval-rwp1", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-06-01T00:00:00Z",
  url: null,
};

const pullRequestReference: WorkerPromptPullRequestReference = {
  provider: "github",
  url: "https://github.com/invenco/foreman/pull/9001",
  number: 9001,
  state: "open",
  headSha: "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678",
  headBranch: "eval-rwp1",
  baseBranch: "main",
  mergeState: "clean",
};

describe("renderWorkerPrompt prior-checkpoint override", () => {
  let workspaceRoot: string;
  let paths: WorkspacePaths;

  beforeAll(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "foreman-rwp-test-"));
    paths = {
      projectRoot: process.cwd(),
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
    };
  });

  afterAll(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const render = (over: { continuation?: boolean; priorCheckpoint?: Record<string, unknown> }) =>
    renderWorkerPrompt({
      action: "reviewer",
      config: createDefaultWorkspaceConfig("eval", "file"),
      paths,
      task,
      repo: { key: "eval-repo", rootPath: path.join(workspaceRoot, "eval-repo"), defaultBranch: "main" },
      worktreePath: path.join(workspaceRoot, "eval-repo"),
      baseBranch: "main",
      pullRequestReference,
      ...over,
    });

  describe("when a pre-resolved checkpoint is supplied on a continuation pass", () => {
    it("renders the synthetic checkpoint instead of the placeholder", async () => {
      const rendered = await render({
        continuation: true,
        priorCheckpoint: { priorPassSummary: "Prior pass raised one thread on the error path.", headSha: pullRequestReference.headSha },
      });
      expect(rendered).toContain("You are continuing a reviewer session");
      expect(rendered).toContain("Prior pass raised one thread on the error path.");
      expect(rendered).not.toContain("No prior checkpoint recorded.");
    });
  });

  describe("when no checkpoint is supplied on a continuation pass", () => {
    it("keeps the live-path placeholder (no foremanRepos backing)", async () => {
      const rendered = await render({ continuation: true });
      expect(rendered).toContain("No prior checkpoint recorded.");
    });
  });

  describe("when a pull-request reference is injected", () => {
    it("renders the synthetic PR in the pull-request context", async () => {
      const rendered = await render({});
      expect(rendered).toContain("https://github.com/invenco/foreman/pull/9001");
    });
  });
});
