import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig } from "../src/workspace/config.js";
import type { ReviewContext, Task } from "../src/domain/index.js";
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

const sampleReviewContext: ReviewContext = {
  provider: "github",
  pullRequestUrl: "https://github.com/acme/repo/pull/1",
  pullRequestNumber: 1,
  state: "open",
  isDraft: false,
  headSha: "abc123",
  headBranch: "task-0001",
  baseBranch: "main",
  headIntroducedAt: "2026-03-14T12:00:00Z",
  mergeState: "clean",
  reviewSummaries: [
    {
      id: "review-1",
      body: "Please tighten this up.",
      authorName: "reviewer",
      authoredByAgent: false,
      createdAt: "2026-03-14T12:05:00Z",
      commitId: "abc123",
      isCurrentHead: true,
    },
    {
      id: "review-2",
      body: "[agent] Fixed in follow-up.",
      authorName: "foreman-bot",
      authoredByAgent: true,
      createdAt: "2026-03-14T12:10:00Z",
      commitId: "abc123",
      isCurrentHead: true,
    },
  ],
  conversationComments: [
    {
      id: "comment-1",
      body: "Can you simplify this flow?",
      authorName: "reviewer",
      authoredByAgent: false,
      createdAt: "2026-03-14T12:07:00Z",
      isAfterCurrentHead: true,
      url: "https://github.com/acme/repo/pull/1#issuecomment-1",
    },
  ],
  reviewThreads: [
    {
      id: "thread-1",
      path: "src/example.ts",
      line: 12,
      isResolved: false,
      comments: [
        {
          id: "thread-comment-1",
          body: "This needs another pass.",
          authorName: "reviewer",
          authoredByAgent: false,
          createdAt: "2026-03-14T12:06:00Z",
          url: "https://github.com/acme/repo/pull/1#discussion_r1",
        },
      ],
    },
  ],
  failingChecks: [{ name: "test", state: "failure" }],
  pendingChecks: [{ name: "lint", state: "pending" }],
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
    expect(result.markdown).not.toContain("{{fragment:");
    expect(result.markdown).not.toContain("{{context:");
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

  test("renders structured review history with actionable items first", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-review-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const reviewPrompt = await renderWorkerPrompt({
      action: "review",
      config,
      paths,
      task: { ...sampleTask, state: "in_review", providerState: "in_review" },
      comments: "(none)",
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      reviewContext: sampleReviewContext,
    });

    const consolidationPrompt = await renderWorkerPrompt({
      action: "consolidation",
      config,
      paths,
      task: { ...sampleTask, state: "done", providerState: "done" },
      comments: "(none)",
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      reviewContext: sampleReviewContext,
    });

    expect(reviewPrompt).toContain("### Actionable Now");
    expect(reviewPrompt).toContain("### Remaining Historical Context");
    expect(reviewPrompt).toContain("Review Summary `review-1`");
    expect(reviewPrompt).toContain("[agent] Fixed in follow-up.");
    expect(reviewPrompt).toContain("Can you simplify this flow?");
    expect(consolidationPrompt).toContain("### Review Summaries");
    expect(consolidationPrompt).toContain("### Review Threads");
    expect(consolidationPrompt).not.toContain("### Actionable Now");
  });
});
