import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { createDefaultWorkspaceConfig } from "../workspace/config.js";
import type { ReviewContext, Task } from "../domain/index.js";
import { renderWorkerPrompt, renderWorkerResultRecoveryPrompt } from "../execution/render-worker-prompt.js";
import { renderPlanPrompt } from "../planning/render-plan-prompt.js";
import { createTempDir, createWorkspacePaths, testProjectRoot } from "../test-support/helpers.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

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
  targets: [{ repoKey: "repo-a", branchName: "task-0001", position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  pullRequests: [],
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
          id: "thread-comment-0",
          body: "Earlier discussion that should stay historical.",
          authorName: "reviewer",
          authoredByAgent: false,
          createdAt: "2026-03-14T12:04:00Z",
          url: "https://github.com/acme/repo/pull/1#discussion_r0",
        },
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
    expect(result.markdown).toContain("`targets`");
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
    expect(result.markdown).toContain(
      "Do not apply the workspace's configured agent-created label to planned tasks unless those tasks are being created by a cron job that references this plan.",
    );
    expect(result.markdown).toContain("## Relevant Learnings");
    expect(result.markdown).toContain("- <learning-id>: <learning title>");
  });

  test("renders worker prompts with generated fragments and runtime context", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-worker-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const result = await renderWorkerPrompt({
      action: "execution",
      config,
      paths,
      task: sampleTask,
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
    });

    expect(result).toContain("# Execution Prompt");
    expect(result).toContain("## Common Worker Rules");
    expect(result).toContain("## File Task Access");
    expect(result).toContain("## GitHub Provider Access");
    expect(result).toContain("## Selected Task");
    expect(result).toContain("## Task Provider Context");
    expect(result).toContain("## Current Git State");
    expect(result).toContain("## Pull Request Reference");
    expect(result).toContain("## Required Output");
    expect(result).toContain("including fetching and inspecting any images attached to the initial task");
    expect(result).toContain("If execution completes with code changes, return a PR review mutation");
    expect(result).not.toContain("Task Comments");
    expect(result).not.toContain("please keep this minimal");
    expect(result).not.toContain("upsert_artifact");
    expect(result).not.toContain("{{fragment:");
    expect(result).not.toContain("{{context:");
  });

  test("renders worker result recovery prompts from a template", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-worker-result-recovery-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const result = await renderWorkerResultRecoveryPrompt({
      action: "execution",
      paths,
      task: sampleTask,
      parseError: new Error("Worker output did not contain a valid <agent-result> block"),
      stdoutArtifactPath: "artifacts/attempt-1-runner-output.txt",
      invalidStdout: "Implemented the change.",
    });

    expect(result).toContain("# Worker Result Recovery Prompt");
    expect(result).toContain("## Parse Failure");
    expect(result).toContain("artifacts/attempt-1-runner-output.txt");
    expect(result).toContain("## Invalid Stdout Excerpt");
    expect(result).toContain("Implemented the change.");
    expect(result).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action execution --help`);
    expect(result).not.toContain("{{context:");
    expect(result).not.toContain("{{fragment:");
    expect(result).not.toContain("{{session:");
  });

  test("renders action-specific agent result validator commands", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-validator-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    const repo = { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" };

    for (const action of ["execution", "review", "reviewer", "retry", "deployment", "consolidation"] as const) {
      const result = await renderWorkerPrompt({
        action,
        config,
        paths,
        task: sampleTask,
        repo,
        worktreePath: workspaceRoot,
        baseBranch: "main",
      });

      expect(result).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action ${action} --help`);
      expect(result).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action ${action}`);
      expect(result).toContain("validate the complete final result block on stdin");
    }

    for (const action of ["review", "reviewer"] as const) {
      const result = await renderWorkerPrompt({
        action,
        config,
        paths,
        task: sampleTask,
        repo,
        worktreePath: workspaceRoot,
        baseBranch: "main",
        continuation: true,
      });

      expect(result).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action ${action} --help`);
      expect(result).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action ${action}`);
      expect(result).toContain("Return exactly one final result block:");
      expect(result).not.toContain("output-schema-continuation");
    }
  });

  test("renders Linear provider access for Linear worker prompts", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-linear-worker-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const result = await renderWorkerPrompt({
      action: "execution",
      config,
      paths,
      task: {
        ...sampleTask,
        provider: "linear",
        providerId: "linear-issue-id",
        url: "https://linear.app/acme/issue/TASK-0001/add-filtering",
      },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
    });

    expect(result).toContain("## Linear Provider Access");
    expect(result).toContain("LINEAR_API_KEY");
    expect(result).toContain("attachments { nodes { id title url } }");
    expect(result).toContain("When downloading Linear-hosted attachments");
    expect(result).toContain("verify the response is an actual image file");
    expect(result).toContain("linear-issue-id");
    expect(result).not.toContain("## File Task Access");
    expect(result).not.toContain("## Provider Access");
  });

  test("renders compact provider references instead of serialized review history", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-review-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const reviewPrompt = await renderWorkerPrompt({
      action: "review",
      config,
      paths,
      task: { ...sampleTask, state: "in_review", providerState: "in_review" },
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
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      reviewContext: sampleReviewContext,
    });

    const reviewerPrompt = await renderWorkerPrompt({
      action: "reviewer",
      config,
      paths,
      task: { ...sampleTask, state: "in_review", providerState: "in_review" },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      reviewContext: sampleReviewContext,
    });

    expect(reviewPrompt).toContain("## Pull Request Reference");
    expect(reviewPrompt).toContain("https://github.com/acme/repo/pull/1");
    expect(reviewPrompt).toContain("\"headSha\": \"abc123\"");
    expect(reviewPrompt).toContain("Discover the current actionable GitHub state before deciding whether code, replies, or thread resolution are needed.");
    expect(reviewPrompt).toContain("include image links or uploaded assets");
    expect(reviewPrompt).toContain("verify the response is an actual image file");
    expect(reviewPrompt).toContain("Do not assume every actionable review item requires a code change.");
    expect(reviewPrompt).toContain("A review pass may complete with reply mutations only");
    expect(reviewPrompt).toContain("Do not reply again to an unresolved review thread when its latest comment was authored by the agent");
    expect(reviewPrompt).toContain("inspect the relevant commit messages and diffs on both the task branch and the base branch");
    expect(reviewPrompt).toContain("Reconcile both branches' intent instead of defaulting to either side.");
    expect(reviewPrompt).toContain("treat the later maintainer decision as authoritative");
    expect(reviewPrompt).toContain("older feedback was superseded instead of changing code");
    expect(reviewPrompt).not.toContain("Review Summary `review-1`");
    expect(reviewPrompt).not.toContain("[agent] Fixed in follow-up.");
    expect(reviewPrompt).not.toContain("Can you simplify this flow?");
    expect(reviewPrompt).not.toContain("This needs another pass.");
    expect(consolidationPrompt).toContain("Discover the relevant task and PR history");
    expect(consolidationPrompt).not.toContain("### Review Summaries");
    expect(consolidationPrompt).not.toContain("### Review Threads");
    expect(consolidationPrompt).not.toContain("### Actionable Now");
    expect(reviewerPrompt).toContain("# Reviewer Prompt");
    expect(reviewerPrompt).toContain("submit_pull_request_review");
    expect(reviewerPrompt).toContain("include image links or uploaded assets");
    expect(reviewerPrompt).not.toContain("### Actionable Now");

    const continuationPrompt = await renderWorkerPrompt({
      action: "review",
      config,
      paths,
      task: { ...sampleTask, state: "in_review", providerState: "in_review" },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      reviewContext: sampleReviewContext,
      gitState: {
        worktreeHeadSha: "current-head",
        reviewHeadSha: "review-head",
        baseBranch: "main",
        previousSessionHeadSha: "previous-head",
      },
      continuation: true,
    });
    expect(continuationPrompt).toContain("Continue addressing current PR feedback, failing checks, and merge conflicts.");
    expect(continuationPrompt).toContain("## Current Git State");
    expect(continuationPrompt).toContain("previousSessionHeadSha");
    expect(continuationPrompt).toContain("previous-head");
    expect(continuationPrompt).not.toContain("## Continuation Worker Rules");
    expect(continuationPrompt).not.toContain("## GitHub Continuation Access");
    expect(continuationPrompt).not.toContain("include image links or uploaded assets");
    expect(continuationPrompt).not.toContain("verify the response is an actual image file");
    expect(continuationPrompt).not.toContain("## Review Continuation Rules");
    expect(continuationPrompt).not.toContain("## Continuation Context");
    expect(continuationPrompt).toContain("## Required Output");
    expect(continuationPrompt).toContain("<agent-result>");
    expect(continuationPrompt).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action review --help`);
    expect(continuationPrompt).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action review`);
    expect(continuationPrompt).not.toContain("Do not assume every actionable review item requires a code change.");
    expect(continuationPrompt).not.toContain("## Common Worker Rules");
    expect(continuationPrompt).not.toContain("## Selected Task");
    expect(continuationPrompt).not.toContain("## Task Provider Context");
    expect(continuationPrompt).not.toContain("## GitHub Provider Access");
    expect(continuationPrompt).not.toContain("create_pull_request");
    expect(continuationPrompt).not.toContain("Allowed learning mutation types");
    expect(continuationPrompt).not.toContain("## Latest Review Activity");
    expect(continuationPrompt).not.toContain("Please tighten this up.");
    expect(continuationPrompt).not.toContain("Earlier discussion that should stay historical.");
    expect(continuationPrompt).not.toContain("### Remaining Historical Context");
    expect(continuationPrompt).not.toContain("[agent] Fixed in follow-up.");

    const reviewerContinuationPrompt = await renderWorkerPrompt({
      action: "reviewer",
      config,
      paths,
      task: { ...sampleTask, state: "in_review", providerState: "in_review" },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      reviewContext: sampleReviewContext,
      gitState: {
        worktreeHeadSha: "current-head",
        reviewHeadSha: "review-head",
        baseBranch: "main",
        previousSessionHeadSha: "previous-reviewer-head",
      },
      continuation: true,
    });
    expect(reviewerContinuationPrompt).toContain("Review the latest PR changes.");
    expect(reviewerContinuationPrompt).toContain("## Current Git State");
    expect(reviewerContinuationPrompt).toContain("previous-reviewer-head");
    expect(reviewerContinuationPrompt).not.toContain("## Continuation Worker Rules");
    expect(reviewerContinuationPrompt).not.toContain("## GitHub Continuation Access");
    expect(reviewerContinuationPrompt).not.toContain("include image links or uploaded assets");
    expect(reviewerContinuationPrompt).not.toContain("## Reviewer Continuation Rules");
    expect(reviewerContinuationPrompt).not.toContain("## Continuation Context");
    expect(reviewerContinuationPrompt).toContain("## Required Output");
    expect(reviewerContinuationPrompt).toContain("<agent-result>");
    expect(reviewerContinuationPrompt).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action reviewer --help`);
    expect(reviewerContinuationPrompt).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action reviewer`);
    expect(reviewerContinuationPrompt).not.toContain("submit_pull_request_review");
    expect(reviewerContinuationPrompt).not.toContain("## Common Worker Rules");
    expect(reviewerContinuationPrompt).not.toContain("## Selected Task");
    expect(reviewerContinuationPrompt).not.toContain("## GitHub Provider Access");
    expect(reviewerContinuationPrompt).not.toContain("## Latest Review Activity");

    const retryPrompt = await renderWorkerPrompt({
      action: "retry",
      config,
      paths,
      task: { ...sampleTask, state: "in_review", providerState: "in_review" },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      continuation: true,
    });
    expect(retryPrompt).toContain("# Retry Prompt");
    expect(retryPrompt).toContain("create_pull_request");
    expect(retryPrompt).not.toContain("# Review Continuation");
  });

  test("renders deployment prompts with workspace plan and deployment instructions", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-deployment-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    await fs.writeFile(paths.planPath, "Ship plan notes", "utf8");
    await fs.writeFile(`${workspaceRoot}/deployment.md`, "Check the production dashboard once.", "utf8");

    const result = await renderWorkerPrompt({
      action: "deployment",
      config,
      paths,
      task: { ...sampleTask, state: "deployable", providerState: "deployable" },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      pullRequestReference: {
        provider: "github",
        url: "https://github.com/acme/repo-a/pull/10",
        number: 10,
        state: "merged",
        headBranch: "task-0001",
        baseBranch: "main",
      },
    });

    expect(result).toContain("# Deployment Tracking Prompt");
    expect(result).toContain("Check once");
    expect(result).toContain("Never poll, sleep, wait");
    expect(result).toContain("return `in_progress`");
    expect(result).toContain("Create a follow-up fix task only when concrete evidence");
    expect(result).toContain("Correctness is the primary goal");
    expect(result).toContain("transitive deployment failure");
    expect(result).toContain("Deployment Instructions section");
    expect(result).toContain("Ship plan notes");
    expect(result).toContain("Check the production dashboard once.");
    expect(result).toContain("https://github.com/acme/repo-a/pull/10");
    expect(result).toContain(`node ${projectRoot}/dist/cli.js agent-result validate --action deployment --help`);
  });

  test("renders deployment inactive context when deployment.md is missing", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-deployment-inactive-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);

    const result = await renderWorkerPrompt({
      action: "deployment",
      config,
      paths,
      task: { ...sampleTask, state: "deployable", providerState: "deployable" },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
    });

    expect(result).toContain("Deployment tracking is inactive because deployment.md was not found");
  });

  test("renders deployment prompts from scout-selected instructions when provided", async () => {
    const workspaceRoot = await createTempDir("foreman-prompts-deployment-selected-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(projectRoot, workspaceRoot);
    await fs.writeFile(`${workspaceRoot}/deployment.md`, "New instructions from disk.", "utf8");

    const result = await renderWorkerPrompt({
      action: "deployment",
      config,
      paths,
      task: { ...sampleTask, state: "deployable", providerState: "deployable" },
      repo: { key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" },
      worktreePath: workspaceRoot,
      baseBranch: "main",
      deploymentInstructionBody: "Scout-selected instructions.",
    });

    expect(result).toContain("Scout-selected instructions.");
    expect(result).not.toContain("New instructions from disk.");
  });
});
