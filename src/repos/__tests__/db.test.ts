import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { actionableReviewThreadFingerprint, priorityToRank } from "../../domain/index.js";
import { addSeconds } from "../../lib/time.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("persistence repos", () => {
  test("creates attempt-owned leases that heartbeat and release by attempt", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.jobs.createJob({
        taskId: "TASK-0001",
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0001:execution",
        selectionReason: "test",
      });

      const attempt = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [
          { resourceType: "task", resourceKey: "TASK-0001" },
          { resourceType: "branch", resourceKey: "repo-a:task-0001" },
        ],
      });

      expect(attempt).not.toBeNull();

      const createdLeases = db.database.sqlite
        .prepare(
          "SELECT execution_attempt_id, released_at FROM lease WHERE worker_id = ? ORDER BY resource_key ASC",
        )
        .all(worker!.id) as Array<{ execution_attempt_id: string; released_at: string | null }>;
      expect(createdLeases).toHaveLength(2);
      expect(createdLeases.every((lease) => lease.execution_attempt_id === attempt!.id)).toBe(true);

      const nextExpiry = addSeconds(new Date(), 240);
      db.workers.heartbeatWorker(worker!.id, attempt!.id, nextExpiry);

      const heartbeatedLeases = db.database.sqlite
        .prepare("SELECT expires_at FROM lease WHERE execution_attempt_id = ? AND released_at IS NULL")
        .all(attempt!.id) as Array<{ expires_at: string }>;
      expect(heartbeatedLeases).toHaveLength(2);
      expect(heartbeatedLeases.every((lease) => lease.expires_at === nextExpiry)).toBe(true);

      db.leases.releaseLeasesForAttempt(attempt!.id, "completed");

      const releasedLeases = db.database.sqlite
        .prepare("SELECT release_reason FROM lease WHERE execution_attempt_id = ?")
        .all(attempt!.id) as Array<{ release_reason: string | null }>;
      expect(releasedLeases.every((lease) => lease.release_reason === "completed")).toBe(true);
      expect(db.leases.hasActiveTaskLease("TASK-0001")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("recovers orphaned running attempts without active leases", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.jobs.createJob({
        taskId: "TASK-0002",
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0002:execution",
        selectionReason: "test",
      });
      const attempt = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [{ resourceType: "task", resourceKey: "TASK-0002" }],
      });

      expect(attempt).not.toBeNull();
      db.workers.updateWorkerStatus(worker!.id, "running", attempt!.id);
      db.jobs.updateJobStatus(job.id, "running", { startedAt: attempt!.startedAt });
      db.leases.releaseLeasesForAttempt(attempt!.id, "expired");

      const recovered = db.attempts.recoverOrphanedRunningAttempts(
        "Recovered abandoned attempt on scheduler startup after prior shutdown",
      );
      expect(recovered).toEqual([{ attemptId: attempt!.id, jobId: job.id, workerId: worker!.id }]);

      expect(db.attempts.getAttempt(attempt!.id).status).toBe("canceled");
      expect(db.jobs.getJob(job.id).status).toBe("canceled");
      expect(db.workers.listWorkers()[0]?.status).toBe("idle");
      expect(db.workers.listWorkers()[0]?.currentAttemptId).toBeNull();

      const events = db.attempts.listAttemptEvents(attempt!.id);
      expect(events.some((event) => event.eventType === "attempt_recovered")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("claims queued jobs for idle workers atomically", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.jobs.createJob({
        taskId: "TASK-0003",
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0003:execution",
        selectionReason: "test",
      });

      expect(db.jobs.claimQueuedJobForWorker(job.id, worker!.id)).toBe(true);
      expect(db.jobs.claimQueuedJobForWorker(job.id, worker!.id)).toBe(false);

      expect(db.jobs.getJob(job.id).status).toBe("leased");
      expect(db.workers.listWorkers()[0]?.status).toBe("leased");

      db.jobs.returnLeasedJobToQueue(job.id);

      expect(db.jobs.getJob(job.id).status).toBe("queued");
      expect(db.jobs.getJob(job.id).leasedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  test("upserts review checkpoints without changing row identity", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      const taskId = "TASK-0004";
      const prUrl = "https://github.com/acme/repo/pull/123";
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();

      const job = db.jobs.createJob({
        taskId,
        taskProvider: "file",
        action: "review",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${taskId}:review`,
        selectionReason: "test",
      });

      const attemptOne = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [],
      });
      const attemptTwo = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 240),
        leases: [],
      });

      expect(attemptOne).not.toBeNull();
      expect(attemptTwo).not.toBeNull();

      db.reviewCheckpoints.upsertReviewCheckpoint({
        taskId,
        prUrl,
        sourceAttemptId: attemptOne!.id,
        reviewContext: {
          provider: "github",
          pullRequestUrl: prUrl,
          pullRequestNumber: 123,
          state: "open",
          isDraft: false,
          headSha: "sha-1",
          headBranch: "feature/task-0004",
          baseBranch: "main",
          headIntroducedAt: "2026-03-16T00:00:00Z",
          mergeState: "clean",
          reviewSummaries: [{ id: "review-1", body: "Needs work", authorName: "reviewer", authoredByAgent: false, createdAt: "2026-03-16T00:00:00Z", commitId: "sha-1", isCurrentHead: true }],
          conversationComments: [{ id: "comment-1", body: "Please fix", authorName: "reviewer", authoredByAgent: false, createdAt: "2026-03-16T00:00:01Z", isAfterCurrentHead: true }],
          reviewThreads: [
            {
              id: "thread-1",
              path: "src/example.ts",
              line: 12,
              isResolved: false,
              comments: [
                {
                  id: "thread-comment-1",
                  body: "Please revisit this",
                  authorName: "reviewer",
                  authoredByAgent: false,
                  createdAt: "2026-03-16T00:00:02Z",
                },
              ],
            },
          ],
          failingChecks: [{ name: "test", state: "failure" }],
          pendingChecks: [{ name: "lint", state: "pending" }],
        },
      });

      const firstCheckpoint = db.reviewCheckpoints.getReviewCheckpoint(taskId, prUrl);
      expect(firstCheckpoint).not.toBeNull();
      expect(firstCheckpoint?.id).toBeDefined();
      expect(firstCheckpoint?.headSha).toBe("sha-1");
      expect(firstCheckpoint?.reviewThreadsFingerprint).toBe(
        actionableReviewThreadFingerprint({
          provider: "github",
          pullRequestUrl: prUrl,
          pullRequestNumber: 123,
          state: "open",
          isDraft: false,
          headSha: "sha-1",
          headBranch: "feature/task-0004",
          baseBranch: "main",
          headIntroducedAt: "2026-03-16T00:00:00Z",
          mergeState: "clean",
          reviewSummaries: [{ id: "review-1", body: "Needs work", authorName: "reviewer", authoredByAgent: false, createdAt: "2026-03-16T00:00:00Z", commitId: "sha-1", isCurrentHead: true }],
          conversationComments: [{ id: "comment-1", body: "Please fix", authorName: "reviewer", authoredByAgent: false, createdAt: "2026-03-16T00:00:01Z", isAfterCurrentHead: true }],
          reviewThreads: [
            {
              id: "thread-1",
              path: "src/example.ts",
              line: 12,
              isResolved: false,
              comments: [
                {
                  id: "thread-comment-1",
                  body: "Please revisit this",
                  authorName: "reviewer",
                  authoredByAgent: false,
                  createdAt: "2026-03-16T00:00:02Z",
                },
              ],
            },
          ],
          failingChecks: [{ name: "test", state: "failure" }],
          pendingChecks: [{ name: "lint", state: "pending" }],
        }),
      );
      expect(firstCheckpoint?.sourceAttemptId).toBe(attemptOne!.id);

      db.reviewCheckpoints.upsertReviewCheckpoint({
        taskId,
        prUrl,
        sourceAttemptId: attemptTwo!.id,
        reviewContext: {
          provider: "github",
          pullRequestUrl: prUrl,
          pullRequestNumber: 123,
          state: "open",
          isDraft: false,
          headSha: "sha-2",
          headBranch: "feature/task-0004",
          baseBranch: "main",
          headIntroducedAt: "2026-03-16T00:05:00Z",
          mergeState: "dirty",
          reviewSummaries: [],
          conversationComments: [],
          reviewThreads: [],
          failingChecks: [],
          pendingChecks: [],
        },
      });

      const secondCheckpoint = db.reviewCheckpoints.getReviewCheckpoint(taskId, prUrl);
      expect(secondCheckpoint?.id).toBe(firstCheckpoint?.id);
      expect(secondCheckpoint?.headSha).toBe("sha-2");
      expect(secondCheckpoint?.mergeState).toBe("dirty");
      expect(secondCheckpoint?.latestReviewSummaryId).toBeNull();
      expect(secondCheckpoint?.latestConversationCommentId).toBeNull();
      expect(secondCheckpoint?.reviewThreadsFingerprint).toBe("[]");
      expect(secondCheckpoint?.sourceAttemptId).toBe(attemptTwo!.id);

      const rowCount = db.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM review_checkpoint WHERE task_id = ? AND pr_url = ?")
        .get(taskId, prUrl) as { count: number };
      expect(rowCount.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("searches learnings across multiple queries and repo scopes with deterministic ordering", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.learnings.addLearning({
        id: "learn-b",
        title: "Planning prompt CLI notes",
        repo: "shared",
        confidence: "established",
        content: "planning prompt learnings cli",
        tags: ["planning"],
      });
      db.learnings.addLearning({
        id: "learn-a",
        title: "Planning prompt CLI notes",
        repo: "foreman",
        confidence: "established",
        content: "planning prompt learnings cli",
        tags: ["planning"],
      });
      db.learnings.addLearning({
        id: "learn-c",
        title: "Planning prompt CLI notes",
        repo: "other-repo",
        confidence: "established",
        content: "planning prompt learnings cli",
        tags: ["planning"],
      });

      db.database.sqlite
        .prepare("UPDATE learning SET updated_at = ? WHERE id IN (?, ?, ?)")
        .run("2026-03-16T00:00:00Z", "learn-a", "learn-b", "learn-c");

      const learnings = db.learnings.searchLearnings({
        queries: ["planning prompt", "learnings cli"],
        repos: ["shared", "foreman"],
        limit: 10,
      });

      expect(learnings.map((learning) => learning.id)).toEqual(["learn-a", "learn-b"]);
      expect(learnings.every((learning) => Number.isFinite(learning.score))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("retrieves learnings by id in requested order", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.learnings.addLearning({
        id: "learn-a",
        title: "First learning",
        repo: "foreman",
        confidence: "emerging",
        content: "First content",
        tags: [],
      });
      db.learnings.addLearning({
        id: "learn-b",
        title: "Second learning",
        repo: "shared",
        confidence: "proven",
        content: "Second content",
        tags: ["planning"],
      });

      const learnings = db.learnings.getLearningsByIds(["learn-b", "missing", "learn-a"]);

      expect(learnings.map((learning) => learning.id)).toEqual(["learn-b", "learn-a"]);
      expect(learnings[0]?.content).toBe("Second content");
      expect(learnings[1]?.content).toBe("First content");
      const readCounts = db.database.sqlite
        .prepare("SELECT id, read_count FROM learning WHERE id IN (?, ?) ORDER BY id ASC")
        .all("learn-a", "learn-b") as Array<{ id: string; read_count: number }>;
      expect(readCounts).toEqual([
        { id: "learn-a", read_count: 0 },
        { id: "learn-b", read_count: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  test("increments read counts only when explicitly requested", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.learnings.addLearning({
        id: "learn-a",
        title: "First learning",
        repo: "foreman",
        confidence: "emerging",
        content: "planning prompt cli",
        tags: [],
      });
      db.learnings.addLearning({
        id: "learn-b",
        title: "Second learning",
        repo: "shared",
        confidence: "proven",
        content: "planning prompt cli",
        tags: ["planning"],
      });

      db.learnings.searchLearnings({ queries: ["planning prompt"], repos: ["shared", "foreman"] }, { incrementReadCount: true });
      db.learnings.getLearningsByIds(["learn-b", "learn-a"], { incrementReadCount: true });

      const readCounts = db.database.sqlite
        .prepare("SELECT id, read_count FROM learning WHERE id IN (?, ?) ORDER BY id ASC")
        .all("learn-a", "learn-b") as Array<{ id: string; read_count: number }>;
      expect(readCounts).toEqual([
        { id: "learn-a", read_count: 2 },
        { id: "learn-b", read_count: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  test("mirrors single-target tasks and derives target dependencies locally", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.taskMirror.saveTasks([
        {
          id: "ENG-4700",
          provider: "linear",
          providerId: "issue-4700",
          title: "Base task",
          description: "Base description",
          state: "in_review",
          providerState: "In Review",
          priority: "high",
          labels: ["Agent"],
          assignee: "Test User",
          repo: "repo-a",
          branchName: "eng-4700",
          dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
          artifacts: [],
          updatedAt: "2026-03-18T12:00:00Z",
          url: "https://linear.app/acme/issue/ENG-4700",
        },
        {
          id: "ENG-4701",
          provider: "linear",
          providerId: "issue-4701",
          title: "Dependent task",
          description: "Dependent description",
          state: "ready",
          providerState: "Todo",
          priority: "normal",
          labels: ["Agent", "Backend"],
          assignee: null,
          repo: "repo-a",
          branchName: "eng-4701",
          dependencies: { taskIds: [], baseTaskId: "ENG-4700", branchNames: ["eng-4700"] },
          artifacts: [],
          updatedAt: "2026-03-18T12:05:00Z",
          url: "https://linear.app/acme/issue/ENG-4701",
        },
        {
          id: "ENG-4702",
          provider: "linear",
          providerId: "issue-4702",
          title: "Repo-less task",
          description: "No repo metadata",
          state: "ready",
          providerState: "Todo",
          priority: "low",
          labels: ["Agent"],
          assignee: null,
          repo: null,
          branchName: null,
          dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
          artifacts: [],
          updatedAt: "2026-03-18T12:10:00Z",
          url: "https://linear.app/acme/issue/ENG-4702",
        },
      ]);

      expect(db.taskMirror.getTask("ENG-4701")).toMatchObject({
        provider: "linear",
        providerId: "issue-4701",
        state: "ready",
        providerState: "Todo",
        labels: ["Agent", "Backend"],
        repo: "repo-a",
        branchName: "eng-4701",
      });
      expect(db.taskMirror.getTasks({ state: "ready" }).map((task) => task.id)).toEqual(["ENG-4702", "ENG-4701"]);
      expect(db.taskMirror.getTasks({ search: "dependent" }).map((task) => task.id)).toEqual(["ENG-4701"]);
      expect(db.taskMirror.getTasks({ taskIds: ["ENG-4701", "ENG-4700"] }).map((task) => task.id)).toEqual([
        "ENG-4701",
        "ENG-4700",
      ]);

      expect(db.taskMirror.getTargetsForTask("ENG-4701")).toHaveLength(1);
      expect(db.taskMirror.getTargetsForTask("ENG-4701")[0]).toMatchObject({
        taskId: "ENG-4701",
        repoKey: "repo-a",
        branchName: "eng-4701",
        position: 0,
      });
      expect(db.taskMirror.getTargetsForTask("ENG-4702")).toEqual([]);

      expect(db.taskMirror.getDependenciesForTask("ENG-4701")).toEqual([
        expect.objectContaining({
          taskId: "ENG-4701",
          dependsOnTaskId: "ENG-4700",
          position: 0,
          isBaseDependency: true,
        }),
      ]);

      const dependentTarget = db.taskMirror.getTargetsForTask("ENG-4701")[0];
      const baseTarget = db.taskMirror.getTargetsForTask("ENG-4700")[0];
      expect(db.taskMirror.getTargetDependenciesForTask("ENG-4701")).toEqual([
        expect.objectContaining({
          taskTargetId: dependentTarget?.id,
          dependsOnTaskTargetId: baseTarget?.id,
          position: 0,
          source: "derived",
        }),
      ]);

      expect(db.taskMirror.getTask("ENG-4701")).toMatchObject({
        id: "ENG-4701",
        repo: "repo-a",
        branchName: "eng-4701",
        dependencies: {
          taskIds: ["ENG-4700"],
          baseTaskId: "ENG-4700",
          branchNames: [],
        },
      });
      expect(db.taskMirror.getTask("ENG-4702")).toMatchObject({ id: "ENG-4702", repo: null, branchName: null });
    } finally {
      db.close();
    }
  });

  test("mirrors multi-target tasks and aligns cross-task dependencies by repo key", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.taskMirror.saveTasks([
        {
          id: "ENG-4800",
          provider: "linear",
          providerId: "issue-4800",
          title: "Shared dependency",
          description: "Base description",
          state: "in_review",
          providerState: "In Review",
          priority: "high",
          labels: ["Agent"],
          assignee: null,
          repo: null,
          branchName: "eng-4800",
          targets: [
            { repo: "common", branchName: "eng-4800", position: 0 },
            { repo: "lynk-frontend", branchName: "eng-4800", position: 1 },
          ],
          dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
          artifacts: [{ type: "pull_request", url: "https://github.com/acme/common/pull/1", repo: "common" }],
          updatedAt: "2026-03-18T12:00:00Z",
          url: "https://linear.app/acme/issue/ENG-4800",
        },
        {
          id: "ENG-4801",
          provider: "linear",
          providerId: "issue-4801",
          title: "Multi-target task",
          description: "Dependent description",
          state: "ready",
          providerState: "Todo",
          priority: "normal",
          labels: ["Agent"],
          assignee: null,
          repo: null,
          branchName: "eng-4801",
          targets: [
            { repo: "common", branchName: "eng-4801", position: 0 },
            { repo: "lynk-frontend", branchName: "eng-4801", position: 1 },
            { repo: "web-front-door", branchName: "eng-4801", position: 2 },
          ],
          repoDependencies: [
            { repo: "lynk-frontend", dependsOnRepo: "common", position: 0 },
            { repo: "web-front-door", dependsOnRepo: "common", position: 1 },
          ],
          dependencies: { taskIds: ["ENG-4800"], baseTaskId: null, branchNames: [] },
          artifacts: [{ type: "pull_request", url: "https://github.com/acme/frontend/pull/2", repo: "lynk-frontend" }],
          updatedAt: "2026-03-18T12:05:00Z",
          url: "https://linear.app/acme/issue/ENG-4801",
        },
      ]);

      expect(db.taskMirror.getTask("ENG-4801")).toMatchObject({
        id: "ENG-4801",
        repo: null,
        branchName: "eng-4801",
        targets: [
          { repo: "common", branchName: "eng-4801", position: 0 },
          { repo: "lynk-frontend", branchName: "eng-4801", position: 1 },
          { repo: "web-front-door", branchName: "eng-4801", position: 2 },
        ],
        repoDependencies: [
          { repo: "lynk-frontend", dependsOnRepo: "common", position: 0 },
          { repo: "web-front-door", dependsOnRepo: "common", position: 1 },
        ],
        artifacts: [{ type: "pull_request", url: "https://github.com/acme/frontend/pull/2", repo: "lynk-frontend" }],
      });

      const targets = db.taskMirror.getTargetsForTask("ENG-4801");
      expect(targets.map((target) => target.repoKey)).toEqual(["common", "lynk-frontend", "web-front-door"]);

      const targetIds = Object.fromEntries(targets.map((target) => [target.repoKey, target.id]));
      const dependencyTargets = Object.fromEntries(db.taskMirror.getTargetsForTask("ENG-4800").map((target) => [target.repoKey, target.id]));
      expect(db.taskMirror.getTargetDependenciesForTask("ENG-4801")).toHaveLength(4);
      expect(db.taskMirror.getTargetDependenciesForTask("ENG-4801")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskTargetId: targetIds["common"],
            dependsOnTaskTargetId: dependencyTargets["common"],
            source: "derived",
          }),
          expect.objectContaining({
            taskTargetId: targetIds["lynk-frontend"],
            dependsOnTaskTargetId: targetIds["common"],
            source: "metadata",
          }),
          expect.objectContaining({
            taskTargetId: targetIds["lynk-frontend"],
            dependsOnTaskTargetId: dependencyTargets["lynk-frontend"],
            source: "derived",
          }),
          expect.objectContaining({
            taskTargetId: targetIds["web-front-door"],
            dependsOnTaskTargetId: targetIds["common"],
            source: "metadata",
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });
});
