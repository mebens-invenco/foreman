import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/workspace/config.js";
import type { Task } from "../src/domain/index.js";
import { renderWorkerPrompt } from "../src/execution/render-worker-prompt.js";
import { renderPlanPrompt } from "../src/planning/render-plan-prompt.js";
import { createTempDir, createWorkspacePaths } from "./helpers.js";

const cleanupDirs: string[] = [];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const sampleTask: Task = {
  id: "TASK-0001",
  provider: "file",
  providerId: "TASK-0001",
  title: "Add filtering",
  description: "Implement filtering for the dashboard.",
  state: "ready",
  providerState: "ready",
  priority: "high",
  labels: ["Agent"],
  assignee: null,
  repo: "repo-a",
  branchName: "task-0001",
  dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
  artifacts: [],
  updatedAt: "2026-03-14T12:00:00Z",
  url: null,
};

describe("prompt rendering", () => {
  test("renders the generated planning template with provider planning fragment", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-plan-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const result = await renderPlanPrompt(config, paths, [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }]);

    expect(result.markdown).toContain("# Planning Prompt");
    expect(result.markdown).toContain("## File Task Planning Rules");
    expect(result.markdown).toContain("## Workspace Context");
    expect(result.markdown).toContain("## Discovered Repositories");
    expect(result.markdown).toContain("## Learnings CLI");
    expect(result.markdown).toContain("foreman learnings search foo --repo shared --repo <repo-key>");
    expect(result.markdown).toContain("yarn foreman learnings search foo");
    expect(result.markdown).toContain("## Relevant Learnings");
    expect(result.markdown).toContain("No strong relevant learnings found in shared/<repo> scope.");
    expect(result.markdown).not.toContain("{{fragment:");
    expect(result.markdown).not.toContain("{{context:");
    expect(result.markdown).not.toContain("{{workspace:");
  });

  test("renders the linear planning fragment with relevant learnings requirements", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-plan-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const result = await renderPlanPrompt(config, paths, [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }]);

    expect(result.markdown).toContain("## Linear Planning Rules");
    expect(result.markdown).toContain("## Relevant Learnings");
    expect(result.markdown).toContain("- <learning-id>: <learning title>");
  });

  test("renders worker prompts with generated fragments and runtime context", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-worker-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), "Follow repo instructions carefully.\n", "utf8");

    const result = await renderWorkerPrompt({
      action: "execution",
      config,
      paths,
      task: sampleTask,
      comments: "- 2026-03-14 human: please keep this minimal",
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
    });

    expect(result).toContain("# Execution Prompt");
    expect(result).toContain("## Common Worker Rules");
    expect(result).toContain("## GitHub Review Rules");
    expect(result).toContain("## Selected Task");
    expect(result).toContain("Follow repo instructions carefully.");
    expect(result).toContain("## Required Output");
    expect(result).toContain("If execution completes with code changes, return a PR review mutation");
    expect(result).not.toContain("upsert_artifact");
    expect(result).not.toContain("{{fragment:");
    expect(result).not.toContain("{{context:");
  });
});
