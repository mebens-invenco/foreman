import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { actionableReviewThreadFingerprint, priorityToRank } from "../../domain/index.js";
import { addSeconds, isoNow } from "../../lib/time.js";
import { createMigratedDb, createTempDir, testProjectRoot } from "../../test-support/helpers.js";
import { createRepos } from "../index.js";
import { openSqliteDatabase } from "../impl/sqlite-database.js";

const cleanupDirs: string[] = [];
const projectRoot = testProjectRoot;

const syncSingleTargetTask = (db: Awaited<ReturnType<typeof createMigratedDb>>, input: { taskId: string; repoKey: string; branchName?: string }) => {
  db.taskMirror.saveTasks([
    {
      id: input.taskId,
      provider: "file",
      providerId: input.taskId,
      title: input.taskId,
      description: "",
      state: "ready",
      providerState: "ready",
      priority: "normal",
      labels: ["Agent"],
      assignee: null,
      targets: [{ repoKey: input.repoKey, branchName: input.branchName ?? input.taskId.toLowerCase(), position: 0 }],
      targetDependencies: [],
      dependencies: { taskIds: [], baseTaskId: null },
      baseBranch: null,
      pullRequests: [],
      runnerOverride: null,
      updatedAt: "2026-03-14T12:00:00Z",
      url: null,
    },
  ]);

  const target = db.taskMirror.getTaskTarget(input.taskId, input.repoKey);
  expect(target).not.toBeNull();
  return target!;
};

// Hand-picked orthogonal vectors, so cosine rank is exactly "which learning does
// this query point at" and the fusion under test is not confounded by a model.
const HYBRID_MODEL = "hybrid-test-model";
const LOCKFILE_VECTOR = Float32Array.from([0, 1, 0]);
const NOISE_VECTOR = Float32Array.from([0, 0, 1]);
// Shares no token with any seeded learning, so bm25 returns nothing for it.
const PARAPHRASE_QUERY = "vendored manifest snapshot discipline";

const seedHybridCorpus = (db: Awaited<ReturnType<typeof createMigratedDb>>) => {
  const corpus = [
    { id: "learn-runner", title: "Pin the GHA runner", content: "workflows must declare ubuntu-24.04", vector: [1, 0, 0] },
    { id: "learn-lockfile", title: "Ship the lockfile", content: "reviewers cannot verify resolution without it", vector: [0, 1, 0] },
    { id: "learn-noise", title: "Unrelated", content: "prisma migrate reset drops every table", vector: [0, 0, 1] },
  ];

  for (const learning of corpus) {
    db.learnings.addLearning({
      id: learning.id,
      title: learning.title,
      repo: "shared",
      confidence: "established",
      content: learning.content,
      tags: [],
    });
    db.learnings.upsertLearningEmbedding({
      learningId: learning.id,
      model: HYBRID_MODEL,
      dims: 3,
      vector: Float32Array.from(learning.vector),
    });
  }
};

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
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-0001", repoKey: "repo-a", branchName: "task-0001" });

      const job = db.jobs.createJob({
        taskId: "TASK-0001",
        taskTargetId: taskTarget.id,
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
        runnerName: "opencode",
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

  test("migrates existing attempts and persists runner providers", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);

    const partialProjectRoot = path.join(tempDir, "partial-project");
    const partialMigrationsDir = path.join(partialProjectRoot, "migrations");
    await fs.mkdir(partialMigrationsDir, { recursive: true });

    const migrationFiles = (await fs.readdir(path.join(projectRoot, "migrations")))
      .filter((fileName) => fileName.endsWith(".sql") && fileName < "0013_")
      .sort();
    await Promise.all(
      migrationFiles.map((fileName) =>
        fs.copyFile(path.join(projectRoot, "migrations", fileName), path.join(partialMigrationsDir, fileName)),
      ),
    );

    const database = await openSqliteDatabase(path.join(tempDir, "foreman.db"));
    const db = createRepos(database) as Awaited<ReturnType<typeof createMigratedDb>>;

    try {
      await db.migrationRunner.runMigrations(partialProjectRoot);

      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      db.database.sqlite
        .prepare(
          `INSERT INTO task(
            id, provider, provider_id, title, description, state, provider_state, priority,
            assignee, url, updated_at, synced_at, labels_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "TASK-0001",
          "file",
          "TASK-0001",
          "TASK-0001",
          "",
          "ready",
          "ready",
          "normal",
          null,
          null,
          "2026-03-14T12:00:00Z",
          "2026-03-14T12:00:00Z",
          "[\"Agent\"]",
        );
      db.database.sqlite
        .prepare(
          `INSERT INTO task_target(id, task_id, repo_key, branch_name, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("target-1", "TASK-0001", "repo-a", "task-0001", 0, "2026-03-14T12:00:00Z", "2026-03-14T12:00:00Z");

      const jobId = "legacy-job-1";
      db.database.sqlite
        .prepare(
          `INSERT INTO job(
            id, task_id, task_target_id, task_provider, action, status, priority_rank, repo_key, base_branch,
            dedupe_key, selection_reason, selection_context_json, scout_run_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, '{}', NULL, ?, ?)`,
        )
        .run(
          jobId,
          "TASK-0001",
          "target-1",
          "file",
          "execution",
          priorityToRank("high"),
          "repo-a",
          "main",
          "TASK-0001:execution",
          "test",
          "2026-03-14T12:00:00.000Z",
          "2026-03-14T12:00:00.000Z",
        );

      const legacyAttemptId = "legacy-attempt-1";
      db.database.sqlite
        .prepare(
          `INSERT INTO execution_attempt(
            id, job_id, worker_id, attempt_number, runner_name, runner_model, runner_variant, status, started_at,
            finished_at, exit_code, signal, summary, error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
        )
        .run(
          legacyAttemptId,
          jobId,
          worker!.id,
          1,
          "opencode",
          "openai/gpt-5.4",
          "high",
          "running",
          "2026-03-14T12:00:00.000Z",
          "",
        );

      await db.migrationRunner.runMigrations(projectRoot);

      expect(db.attempts.getAttempt(legacyAttemptId)).toMatchObject({
        id: legacyAttemptId,
        runnerName: "opencode",
      });

      const claudeAttempt = db.attempts.createAttempt({
        jobId,
        workerId: worker!.id,
        runnerName: "claude",
        runnerModel: "claude-opus-4-6",
        runnerVariant: "high",
      });

      expect(db.attempts.getAttempt(claudeAttempt.id)).toMatchObject({
        id: claudeAttempt.id,
        runnerName: "claude",
        runnerModel: "claude-opus-4-6",
        runnerVariant: "high",
      });
    } finally {
      db.close();
    }
  });

  test("rejects unknown runner names on read and on write", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-RUNNER", repoKey: "repo-a", branchName: "task-runner" });
      const job = db.jobs.createJob({
        taskId: "TASK-RUNNER",
        taskTargetId: taskTarget.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-RUNNER:execution",
        selectionReason: "test",
      });

      // Write-side guard: the boundary rejects unknown providers before they hit SQL.
      expect(() =>
        db.attempts.createAttempt({
          jobId: job.id,
          workerId: worker!.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runnerName: "phantom-runner" as any,
          runnerModel: "m",
          runnerVariant: "v",
        }),
      ).toThrow(/Unknown runner provider/);
      expect(() =>
        db.runnerSessions.createSession({
          taskTargetId: taskTarget.id,
          role: "implementation",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runnerName: "phantom-runner" as any,
          runnerModel: "m",
          runnerVariant: "v",
          isActive: false,
          nativeSessionId: null,
        }),
      ).toThrow(/Unknown runner provider/);

      // Read-side guard: smuggle a bad row in via raw SQL (post-migration the DB lets it through)
      // and confirm the boundary fails the read instead of leaking the string as RunnerProvider.
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "m",
        runnerVariant: "v",
      });
      db.database.sqlite
        .prepare("UPDATE execution_attempt SET runner_name = 'phantom-runner' WHERE id = ?")
        .run(attempt.id);
      expect(() => db.attempts.getAttempt(attempt.id)).toThrow(/Unknown runner provider/);

      const session = db.runnerSessions.createSession({
        taskTargetId: taskTarget.id,
        role: "implementation",
        runnerName: "opencode",
        runnerModel: "m",
        runnerVariant: "v",
        isActive: true,
        nativeSessionId: "smuggle-1",
      });
      db.database.sqlite
        .prepare("UPDATE runner_session SET runner_name = 'phantom-runner' WHERE id = ?")
        .run(session.id);
      expect(() =>
        db.runnerSessions.getActiveSession({
          taskTargetId: taskTarget.id,
          role: "implementation",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          runnerName: "phantom-runner" as any,
          runnerModel: "m",
          runnerVariant: "v",
        }),
      ).toThrow(/Unknown runner provider/);

      // Every canonical provider is accepted post-migration.
      for (const [index, runnerName] of (["opencode", "claude", "codex"] as const).entries()) {
        const ok = db.attempts.createAttempt({
          jobId: job.id,
          workerId: worker!.id,
          runnerName,
          runnerModel: `model-${index}`,
          runnerVariant: "v",
        });
        expect(ok.runnerName).toBe(runnerName);
      }
    } finally {
      db.close();
    }
  });

  test("persists runner sessions by role and runner config", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-SESSIONS", repoKey: "repo-a", branchName: "task-sessions" });
      const job = db.jobs.createJob({
        taskId: "TASK-SESSIONS",
        taskTargetId: taskTarget.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-SESSIONS:execution",
        selectionReason: "test",
      });
      const attempt = db.attempts.createAttempt({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      });

      const selector = {
        taskTargetId: taskTarget.id,
        role: "implementation" as const,
        runnerName: "opencode" as const,
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
      };
      const implementation = db.runnerSessions.createSession({ ...selector, isActive: false, nativeSessionId: "impl-1" });
      db.attempts.linkRunnerSession(attempt.id, implementation.id);
      db.runnerSessions.updateSession(implementation.id, {
        isActive: true,
        lastAttemptId: attempt.id,
        lastWorktreeHeadSha: "head-1",
        lastReviewHeadSha: "pr-head-1",
      });

      expect(db.attempts.getAttempt(attempt.id).runnerSessionId).toBe(implementation.id);
      expect(db.runnerSessions.getActiveSession(selector)).toMatchObject({
        id: implementation.id,
        nativeSessionId: "impl-1",
        lastWorktreeHeadSha: "head-1",
        lastReviewHeadSha: "pr-head-1",
      });
      db.runnerSessions.updateSession(implementation.id, { lastReviewHeadSha: null });
      expect(db.runnerSessions.getActiveSession(selector)).toMatchObject({
        id: implementation.id,
        lastReviewHeadSha: null,
      });
      expect(db.runnerSessions.getActiveSession({ ...selector, runnerModel: "other-model" })).toBeNull();

      const reviewer = db.runnerSessions.createSession({
        ...selector,
        role: "reviewer",
        runnerName: "claude",
        runnerModel: "claude-opus-4-6",
        nativeSessionId: "reviewer-1",
        isActive: true,
      });
      expect(
        db.runnerSessions.getActiveSession({
          ...selector,
          role: "reviewer",
          runnerName: "claude",
          runnerModel: "claude-opus-4-6",
        })?.id,
      ).toBe(reviewer.id);
      expect(db.runnerSessions.getActiveSession({ ...selector, role: "reviewer" })).toBeNull();

      const deployment = db.runnerSessions.createSession({
        ...selector,
        role: "deployment",
        nativeSessionId: "deployment-1",
        isActive: true,
      });
      expect(db.runnerSessions.getActiveSession({ ...selector, role: "deployment" })).toMatchObject({
        id: deployment.id,
        nativeSessionId: "deployment-1",
      });

      const retrySession = db.runnerSessions.createSession({ ...selector, isActive: false, nativeSessionId: "impl-2" });
      expect(db.runnerSessions.getActiveSession(selector)?.id).toBe(implementation.id);
      db.runnerSessions.updateSession(retrySession.id, { isActive: true, lastAttemptId: attempt.id, lastWorktreeHeadSha: "head-2" });
      expect(db.runnerSessions.getActiveSession(selector)).toMatchObject({ id: retrySession.id, nativeSessionId: "impl-2" });
    } finally {
      db.close();
    }
  });

  test("persists cron jobs with nullable task fields and runner output artifacts", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      const job = db.jobs.createCronJob({
        cronJobId: "cron/check.md",
        dedupeKey: "cron:cron/check.md",
        selectionReason: "test cron",
      });

      expect(job).toMatchObject({
        jobKind: "cron",
        taskId: null,
        taskTargetId: null,
        taskProvider: null,
        cronJobId: "cron/check.md",
        action: "cron",
        repoKey: null,
      });
      expect(db.jobs.latestJobForDedupeKey("cron:cron/check.md")?.id).toBe(job.id);

      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      const attempt = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "standard",
        expiresAt: "2026-03-16T00:10:00Z",
        leases: [{ resourceType: "cron", resourceKey: job.dedupeKey }],
      });
      expect(attempt).toMatchObject({
        jobKind: "cron",
        taskId: null,
        target: null,
        cronJobId: "cron/check.md",
        stage: "cron",
      });

      db.artifacts.createArtifact({
        ownerType: "execution_attempt",
        ownerId: "attempt-1",
        artifactType: "runner_output",
        relativePath: "artifacts/attempt-1-runner-output.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
      });

      expect(db.artifacts.listArtifacts("execution_attempt", "attempt-1")[0]).toMatchObject({
        artifactType: "runner_output",
      });
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
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-0002", repoKey: "repo-a", branchName: "task-0002" });

      const job = db.jobs.createJob({
        taskId: "TASK-0002",
        taskTargetId: taskTarget.id,
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
        runnerName: "opencode",
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

  test("recovers orphaned running attempts after expired leases are reaped", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-0003", repoKey: "repo-a", branchName: "task-0003" });

      const job = db.jobs.createJob({
        taskId: "TASK-0003",
        taskTargetId: taskTarget.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0003:execution",
        selectionReason: "test",
      });
      const attempt = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), -120),
        leases: [{ resourceType: "task", resourceKey: "TASK-0003" }],
      });

      expect(attempt).not.toBeNull();
      db.workers.updateWorkerStatus(worker!.id, "running", attempt!.id);
      db.jobs.updateJobStatus(job.id, "running", { startedAt: attempt!.startedAt });

      expect(db.leases.reapExpiredLeases(isoNow())).toBe(1);
      const recovered = db.attempts.recoverOrphanedRunningAttempts(
        "Recovered abandoned attempt after stale leases expired",
      );

      expect(recovered).toEqual([{ attemptId: attempt!.id, jobId: job.id, workerId: worker!.id }]);
      expect(db.attempts.getAttempt(attempt!.id).status).toBe("canceled");
      expect(db.jobs.getJob(job.id).status).toBe("canceled");
      expect(db.workers.listWorkers()[0]?.status).toBe("idle");
      expect(db.workers.listWorkers()[0]?.currentAttemptId).toBeNull();
    } finally {
      db.close();
    }
  });

  test("does not recover orphaned running attempts for excluded workers", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-0004", repoKey: "repo-a", branchName: "task-0004" });

      const job = db.jobs.createJob({
        taskId: "TASK-0004",
        taskTargetId: taskTarget.id,
        taskProvider: "file",
        action: "execution",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0004:execution",
        selectionReason: "test",
      });
      const attempt = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), -120),
        leases: [{ resourceType: "task", resourceKey: "TASK-0004" }],
      });

      expect(attempt).not.toBeNull();
      db.workers.updateWorkerStatus(worker!.id, "running", attempt!.id);
      db.jobs.updateJobStatus(job.id, "running", { startedAt: attempt!.startedAt });
      db.leases.reapExpiredLeases(isoNow());

      const recovered = db.attempts.recoverOrphanedRunningAttempts(
        "Recovered abandoned attempt after stale leases expired",
        { excludeWorkerIds: [worker!.id] },
      );

      expect(recovered).toEqual([]);
      expect(db.attempts.getAttempt(attempt!.id).status).toBe("running");
      expect(db.jobs.getJob(job.id).status).toBe("running");
      expect(db.workers.listWorkers()[0]?.status).toBe("running");
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
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-0003", repoKey: "repo-a", branchName: "task-0003" });

      const job = db.jobs.createJob({
        taskId: "TASK-0003",
        taskTargetId: taskTarget.id,
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
      expect(db.jobs.getJob(job.id).nextEligibleAt).toBeNull();
    } finally {
      db.close();
    }
  });

  test("does not claim queued jobs before their next eligible time", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const taskTarget = syncSingleTargetTask(db, { taskId: "TASK-0003B", repoKey: "repo-a", branchName: "task-0003b" });

      const job = db.jobs.createJob({
        taskId: "TASK-0003B",
        taskTargetId: taskTarget.id,
        taskProvider: "file",
        action: "review",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: "TASK-0003B:repo-a:review",
        selectionReason: "test",
      });

      expect(db.jobs.claimQueuedJobForWorker(job.id, worker!.id)).toBe(true);
      db.jobs.returnLeasedJobToQueue(job.id, { nextEligibleAt: "2999-01-01T00:00:00.000Z" });
      db.workers.updateWorkerStatus(worker!.id, "idle", null);

      expect(db.jobs.claimQueuedJobForWorker(job.id, worker!.id)).toBe(false);
      expect(db.jobs.getJob(job.id).status).toBe("queued");
      expect(db.jobs.getJob(job.id).leasedAt).toBeNull();
      expect(db.jobs.getJob(job.id).nextEligibleAt).toBe("2999-01-01T00:00:00.000Z");
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
      const taskTarget = syncSingleTargetTask(db, { taskId, repoKey: "repo-a", branchName: "task-0004" });

      const job = db.jobs.createJob({
        taskId,
        taskTargetId: taskTarget.id,
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
        runnerName: "opencode",
        runnerModel: "openai/gpt-5.4",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [],
      });
      const attemptTwo = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "claude",
        runnerModel: "claude-opus-4-6",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 240),
        leases: [],
      });

      expect(attemptOne).not.toBeNull();
      expect(attemptTwo).not.toBeNull();
      expect(db.jobs.latestJobForTaskTarget(taskTarget.id)?.id).toBe(job.id);
      expect(db.attempts.latestAttemptForTaskTarget(taskTarget.id)?.id).toBe(attemptTwo!.id);

      db.reviewCheckpoints.upsertReviewCheckpoint({
        taskId,
        taskTargetId: taskTarget.id,
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

      const firstCheckpoint = db.reviewCheckpoints.getReviewCheckpoint(taskTarget.id);
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
        taskTargetId: taskTarget.id,
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

      const secondCheckpoint = db.reviewCheckpoints.getReviewCheckpoint(taskTarget.id);
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

  test("upserts reviewer checkpoints without changing row identity", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      const taskId = "TASK-0004R";
      const prUrl = "https://github.com/acme/repo/pull/124";
      db.workers.ensureWorkerSlots(1);
      const worker = db.workers.listWorkers()[0];
      expect(worker).toBeDefined();
      const taskTarget = syncSingleTargetTask(db, { taskId, repoKey: "repo-a", branchName: "task-0004r" });

      const job = db.jobs.createJob({
        taskId,
        taskTargetId: taskTarget.id,
        taskProvider: "file",
        action: "reviewer",
        priorityRank: priorityToRank("high"),
        repoKey: "repo-a",
        baseBranch: "main",
        dedupeKey: `${taskId}:reviewer`,
        selectionReason: "test",
      });

      const attemptOne = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "claude",
        runnerModel: "claude-opus-4-6",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 120),
        leases: [],
      });
      const attemptTwo = db.attempts.createAttemptWithLeases({
        jobId: job.id,
        workerId: worker!.id,
        runnerName: "claude",
        runnerModel: "claude-opus-4-6",
        runnerVariant: "high",
        expiresAt: addSeconds(new Date(), 240),
        leases: [],
      });

      expect(attemptOne).not.toBeNull();
      expect(attemptTwo).not.toBeNull();

      db.reviewerCheckpoints.upsertReviewerCheckpoint({
        taskId,
        taskTargetId: taskTarget.id,
        prUrl,
        sourceAttemptId: attemptOne!.id,
        reviewContext: {
          provider: "github",
          pullRequestUrl: prUrl,
          pullRequestNumber: 124,
          state: "open",
          isDraft: true,
          headSha: "sha-r1",
          headBranch: "feature/task-0004r",
          baseBranch: "main",
          headIntroducedAt: "2026-03-16T00:00:00Z",
          mergeState: "clean",
          reviewSummaries: [],
          conversationComments: [],
          reviewThreads: [],
          failingChecks: [],
          pendingChecks: [],
        },
      });

      const firstCheckpoint = db.reviewerCheckpoints.getReviewerCheckpoint(taskTarget.id);
      expect(firstCheckpoint).not.toBeNull();
      expect(firstCheckpoint?.headSha).toBe("sha-r1");
      expect(firstCheckpoint?.sourceAttemptId).toBe(attemptOne!.id);

      db.reviewerCheckpoints.upsertReviewerCheckpoint({
        taskId,
        taskTargetId: taskTarget.id,
        prUrl,
        sourceAttemptId: attemptTwo!.id,
        reviewContext: {
          provider: "github",
          pullRequestUrl: prUrl,
          pullRequestNumber: 124,
          state: "open",
          isDraft: true,
          headSha: "sha-r2",
          headBranch: "feature/task-0004r",
          baseBranch: "main",
          headIntroducedAt: "2026-03-16T00:05:00Z",
          mergeState: "clean",
          reviewSummaries: [],
          conversationComments: [],
          reviewThreads: [],
          failingChecks: [],
          pendingChecks: [],
        },
      });

      const secondCheckpoint = db.reviewerCheckpoints.getReviewerCheckpoint(taskTarget.id);
      expect(secondCheckpoint?.id).toBe(firstCheckpoint?.id);
      expect(secondCheckpoint?.headSha).toBe("sha-r2");
      expect(secondCheckpoint?.sourceAttemptId).toBe(attemptTwo!.id);

      const rowCount = db.database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM reviewer_checkpoint WHERE task_id = ? AND pr_url = ?")
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

  test("round-trips learning embedding vectors through the BLOB column", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.learnings.addLearning({
        id: "learn-vec",
        title: "Vector",
        repo: "foreman",
        confidence: "emerging",
        content: "body",
        tags: [],
      });

      const vector = Float32Array.from([-1.5, 0, 0.25, 1e-8, 3.4e38]);
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-vec",
        model: "test-model",
        dims: vector.length,
        vector,
        embeddedTitle: "Vector",
        embeddedContent: "body",
      });

      const [stored] = db.learnings.getLearningEmbeddings();
      expect(stored).toEqual({ learningId: "learn-vec", model: "test-model", dims: 5, vector });
      expect(Array.from(stored!.vector)).toEqual(Array.from(vector));

      // Upsert replaces rather than duplicating the primary-key row.
      const replacement = Float32Array.from([9, 8, 7]);
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-vec",
        model: "other-model",
        dims: replacement.length,
        vector: replacement,
        embeddedTitle: "Vector",
        embeddedContent: "body",
      });
      const embeddings = db.learnings.getLearningEmbeddings();
      expect(embeddings).toHaveLength(1);
      expect(embeddings[0]!.model).toBe("other-model");
      expect(Array.from(embeddings[0]!.vector)).toEqual([9, 8, 7]);
    } finally {
      db.close();
    }
  });

  test("scopes learning embeddings to one model generation, alone or combined with repo", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      // A mixed-generation table: exactly the state a model swap leaves behind
      // until `backfill-embeddings` is run.
      const rows = [
        ["learn-new-f", "foreman", "new-model"],
        ["learn-old-f", "foreman", "retired-model"],
        ["learn-new-s", "shared", "new-model"],
      ] as const;
      for (const [id, repo, model] of rows) {
        db.learnings.addLearning({ id, title: id, repo, confidence: "emerging", content: "body", tags: [] });
        db.learnings.upsertLearningEmbedding({
          learningId: id,
          model,
          dims: 2,
          vector: Float32Array.from([1, 2]),
          embeddedTitle: id,
          embeddedContent: "body",
        });
      }

      expect(db.learnings.getLearningEmbeddings({ model: "new-model" }).map((row) => row.learningId)).toEqual([
        "learn-new-f",
        "learn-new-s",
      ]);
      expect(db.learnings.getLearningEmbeddings({ model: "new-model", repos: ["foreman"] }).map((row) => row.learningId)).toEqual([
        "learn-new-f",
      ]);
      expect(db.learnings.getLearningEmbeddings({ model: "absent-model" })).toEqual([]);
      // Omitting the filter still returns every generation.
      expect(db.learnings.getLearningEmbeddings()).toHaveLength(3);

      // Counting reads the same scope, without decoding a single vector.
      expect(db.learnings.countLearningEmbeddings({ model: "new-model" })).toBe(2);
      expect(db.learnings.countLearningEmbeddings({ model: "new-model", repos: ["foreman"] })).toBe(1);
      expect(db.learnings.countLearningEmbeddings({ model: "absent-model" })).toBe(0);
      expect(db.learnings.countLearningEmbeddings()).toBe(3);
    } finally {
      db.close();
    }
  });

  test("fuses a cosine hit FTS cannot reach with a bm25 hit cosine ranks low", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      seedHybridCorpus(db);

      // Paraphrase: not one token in common with `learn-lockfile`, so bm25 sees
      // nothing at all. Its query vector points straight at the lockfile vector.
      expect(db.learnings.searchLearnings({ queries: [PARAPHRASE_QUERY], repos: ["shared"] })).toEqual([]);
      const paraphrase = db.learnings.searchLearningsHybrid(
        { queries: [PARAPHRASE_QUERY], repos: ["shared"] },
        { model: HYBRID_MODEL, vectors: [LOCKFILE_VECTOR] },
      );
      expect(paraphrase.map((learning) => learning.id)[0]).toBe("learn-lockfile");

      // Exact token: bm25 alone matches `learn-runner`, while the query vector
      // points at an unrelated learning. Agreement is not required — a strong
      // bm25 rank still leads the fusion.
      const exactToken = db.learnings.searchLearningsHybrid(
        { queries: ["ubuntu-24.04"], repos: ["shared"] },
        { model: HYBRID_MODEL, vectors: [NOISE_VECTOR] },
      );
      expect(exactToken.map((learning) => learning.id)[0]).toBe("learn-runner");
      expect(exactToken.map((learning) => learning.id)).toContain("learn-noise");
    } finally {
      db.close();
    }
  });

  test("ranks hybrid results by descending fused score and paginates after fusion", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      seedHybridCorpus(db);

      const ranked = db.learnings.searchLearningsHybrid(
        { queries: [PARAPHRASE_QUERY], repos: ["shared"] },
        { model: HYBRID_MODEL, vectors: [LOCKFILE_VECTOR] },
      );
      // Fused score is a relevance score: unlike raw bm25, higher wins.
      expect(ranked).toHaveLength(3);
      expect(ranked.map((learning) => learning.score)).toEqual([...ranked.map((learning) => learning.score)].sort((left, right) => right - left));

      // `limit`/`offset` cut the fused ranking, not the per-pipeline candidates.
      const page = db.learnings.searchLearningsHybrid(
        { queries: [PARAPHRASE_QUERY], repos: ["shared"], limit: 1, offset: 1 },
        { model: HYBRID_MODEL, vectors: [LOCKFILE_VECTOR] },
      );
      expect(page.map((learning) => learning.id)).toEqual([ranked[1]!.id]);
    } finally {
      db.close();
    }
  });

  test("ignores learnings embedded under another model and counts reads once per hit", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      seedHybridCorpus(db);

      // A vector from another model generation is a different space entirely; it
      // must never be ranked against this query. Only bm25 may surface its row.
      const otherModel = db.learnings.searchLearningsHybrid(
        { queries: [PARAPHRASE_QUERY], repos: ["shared"] },
        { model: "other-model", vectors: [LOCKFILE_VECTOR] },
      );
      expect(otherModel).toEqual([]);

      db.learnings.searchLearningsHybrid(
        { queries: [PARAPHRASE_QUERY], repos: ["shared"] },
        { model: HYBRID_MODEL, vectors: [LOCKFILE_VECTOR] },
        { incrementReadCount: true },
      );
      expect(db.learnings.getLearningsByIds(["learn-lockfile"])[0]!.readCount).toBe(1);
    } finally {
      db.close();
    }
  });

  test("refuses a query vector list that does not line up with the queries", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      seedHybridCorpus(db);

      // Zipped by index: a short list would silently embed the wrong query.
      expect(() =>
        db.learnings.searchLearningsHybrid({ queries: ["a", "b"] }, { model: HYBRID_MODEL, vectors: [LOCKFILE_VECTOR] }),
      ).toThrow(/1 query vectors for 2 queries/);

      // A blank query drops out with its vector, keeping the rest aligned.
      const aligned = db.learnings.searchLearningsHybrid(
        { queries: ["   ", PARAPHRASE_QUERY], repos: ["shared"] },
        { model: HYBRID_MODEL, vectors: [NOISE_VECTOR, LOCKFILE_VECTOR] },
      );
      expect(aligned.map((learning) => learning.id)[0]).toBe("learn-lockfile");
    } finally {
      db.close();
    }
  });

  test("scopes learning embeddings by repo and cascades deletes from the learning row", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      for (const [id, repo] of [["learn-f", "foreman"], ["learn-s", "shared"]] as const) {
        db.learnings.addLearning({ id, title: id, repo, confidence: "emerging", content: "body", tags: [] });
        db.learnings.upsertLearningEmbedding({
          learningId: id,
          model: "m",
          dims: 2,
          vector: Float32Array.from([1, 2]),
          embeddedTitle: id,
          embeddedContent: "body",
        });
      }

      expect(db.learnings.getLearningEmbeddings({ repos: ["foreman"] }).map((row) => row.learningId)).toEqual(["learn-f"]);
      expect(db.learnings.getLearningEmbeddings().map((row) => row.learningId)).toEqual(["learn-f", "learn-s"]);

      db.database.sqlite.prepare("DELETE FROM learning WHERE id = ?").run("learn-f");
      expect(db.learnings.getLearningEmbeddings().map((row) => row.learningId)).toEqual(["learn-s"]);
    } finally {
      db.close();
    }
  });

  test("lists learning ids whose embedding is absent, from another model, or stale", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      for (const id of ["learn-absent", "learn-other-model", "learn-stale", "learn-current"]) {
        db.learnings.addLearning({ id, title: id, repo: "foreman", confidence: "emerging", content: "body", tags: [] });
      }

      const vector = Float32Array.from([1, 2]);
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-other-model",
        model: "old-model",
        dims: 2,
        vector,
        embeddedTitle: "learn-other-model",
        embeddedContent: "body",
      });
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-stale",
        model: "current-model",
        dims: 2,
        vector,
        embeddedTitle: "learn-stale",
        embeddedContent: "body",
      });
      db.learnings.upsertLearningEmbedding({
        learningId: "learn-current",
        model: "current-model",
        dims: 2,
        vector,
        embeddedTitle: "learn-current",
        embeddedContent: "body",
      });

      // Bump only the stale learning past its embedding's timestamp. An explicit
      // offset keeps this deterministic: two isoNow() calls can land on the same
      // millisecond, and an equal timestamp means "current", not "stale".
      db.database.sqlite
        .prepare("UPDATE learning SET updated_at = ? WHERE id = ?")
        .run(addSeconds(isoNow(), 60), "learn-stale");

      expect(db.learnings.listLearningIdsMissingEmbedding("current-model")).toEqual([
        "learn-absent",
        "learn-other-model",
        "learn-stale",
      ]);
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

  test("listLearnings never increments read counts", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      db.learnings.addLearning({ id: "learn-a", title: "First", repo: "foreman", confidence: "emerging", content: "planning prompt cli", tags: [] });
      db.learnings.addLearning({ id: "learn-b", title: "Second", repo: "shared", confidence: "proven", content: "planning prompt cli", tags: ["planning"] });

      // The plan-index render path lists the whole corpus and, with a search
      // filter, funnels through the FTS path — neither is an agent read.
      db.learnings.listLearnings();
      db.learnings.listLearnings({ repo: "shared" });
      db.learnings.listLearnings({ search: "planning prompt" });

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
          targets: [{ repoKey: "repo-a", branchName: "eng-4700", position: 0 }],
          targetDependencies: [],
          dependencies: { taskIds: [], baseTaskId: null },
          baseBranch: null,
          pullRequests: [],
          runnerOverride: null,
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
          targets: [{ repoKey: "repo-a", branchName: "eng-4701", position: 0 }],
          targetDependencies: [],
          dependencies: { taskIds: [], baseTaskId: "ENG-4700" },
          baseBranch: "release/base",
          pullRequests: [],
          runnerOverride: null,
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
          targets: [],
          targetDependencies: [],
          dependencies: { taskIds: [], baseTaskId: null },
          baseBranch: null,
          pullRequests: [],
          runnerOverride: null,
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
        targets: [{ repoKey: "repo-a", branchName: "eng-4701", position: 0 }],
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
        targets: [{ repoKey: "repo-a", branchName: "eng-4701", position: 0 }],
        dependencies: {
          taskIds: ["ENG-4700"],
          baseTaskId: "ENG-4700",
        },
        baseBranch: "release/base",
      });
      expect(db.taskMirror.getTask("ENG-4702")).toMatchObject({ id: "ENG-4702", targets: [] });
    } finally {
      db.close();
    }
  });

  test("setTaskLabels updates labels in place without disturbing targets or dependencies", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      const base = syncSingleTargetTask(db, { taskId: "ENG-9000", repoKey: "repo-a" });
      db.taskMirror.saveTasks([
        {
          id: "ENG-9001",
          provider: "linear",
          providerId: "issue-9001",
          title: "Dependent",
          description: "",
          state: "ready",
          providerState: "Todo",
          priority: "normal",
          labels: ["Agent"],
          assignee: null,
          targets: [{ repoKey: "repo-a", branchName: "eng-9001", position: 0 }],
          targetDependencies: [],
          dependencies: { taskIds: ["ENG-9000"], baseTaskId: null },
          baseBranch: null,
          pullRequests: [],
          runnerOverride: null,
          updatedAt: "2026-03-18T12:00:00Z",
          url: null,
        },
      ]);

      const dependentTargetBefore = db.taskMirror.getTargetsForTask("ENG-9001")[0];
      const targetDepsBefore = db.taskMirror.getTargetDependenciesForTask("ENG-9001");
      expect(targetDepsBefore).toEqual([
        expect.objectContaining({
          taskTargetId: dependentTargetBefore?.id,
          dependsOnTaskTargetId: base.id,
          source: "derived",
        }),
      ]);

      db.taskMirror.setTaskLabels("ENG-9001", ["Agent", "agent:disabled"]);

      // Labels updated…
      expect(db.taskMirror.getTask("ENG-9001")?.labels).toEqual(["Agent", "agent:disabled"]);
      // …while target ids and the derived dependency graph are untouched (the
      // regression saveTasks would have caused: a full target-dependency rebuild).
      expect(db.taskMirror.getTargetsForTask("ENG-9001")[0]?.id).toEqual(dependentTargetBefore?.id);
      expect(db.taskMirror.getTargetDependenciesForTask("ENG-9001")).toEqual(targetDepsBefore);
    } finally {
      db.close();
    }
  });

  test("mirrors multi-target tasks, persists metadata dependencies, and preserves target ids", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      const dependencyTask = {
        id: "ENG-4773",
        provider: "linear" as const,
        providerId: "issue-4773",
        title: "Upstream repo rollout",
        description: "Dependency",
        state: "in_review" as const,
        providerState: "In Review",
        priority: "normal" as const,
        labels: ["Agent"],
        assignee: null,
        targets: [
          { repoKey: "common", branchName: "eng-4773", position: 0 },
          { repoKey: "lynk-frontend", branchName: "eng-4773", position: 1 },
        ],
        targetDependencies: [],
        dependencies: { taskIds: [], baseTaskId: null },
        baseBranch: null,
        pullRequests: [],
        runnerOverride: null,
        updatedAt: "2026-03-18T12:00:00Z",
        url: "https://linear.app/acme/issue/ENG-4773",
      };
      const task = {
        id: "ENG-4774",
        provider: "linear" as const,
        providerId: "issue-4774",
        title: "Multi-target rollout",
        description: "Task",
        state: "ready" as const,
        providerState: "Todo",
        priority: "high" as const,
        labels: ["Agent"],
        assignee: null,
        targets: [
          { repoKey: "common", branchName: "eng-4774", position: 0 },
          { repoKey: "lynk-frontend", branchName: "eng-4774", position: 1 },
          { repoKey: "web-front-door", branchName: "eng-4774", position: 2 },
        ],
        targetDependencies: [
          { taskTargetRepoKey: "lynk-frontend", dependsOnRepoKey: "common", position: 0 },
          { taskTargetRepoKey: "web-front-door", dependsOnRepoKey: "common", position: 1 },
        ],
        dependencies: { taskIds: ["ENG-4773"], baseTaskId: "ENG-4773" },
        baseBranch: "release/base",
        pullRequests: [],
        runnerOverride: null,
        updatedAt: "2026-03-18T12:05:00Z",
        url: "https://linear.app/acme/issue/ENG-4774",
      };

      db.taskMirror.saveTasks([dependencyTask, task]);

      const firstTargets = db.taskMirror.getTargetsForTask(task.id);
      expect(firstTargets.map((target) => target.repoKey)).toEqual(["common", "lynk-frontend", "web-front-door"]);
      const targetIdsByRepo = new Map(firstTargets.map((target) => [target.repoKey, target.id]));

      db.taskMirror.saveTasks([{ ...dependencyTask }, { ...task, title: "Updated multi-target rollout" }]);

      const refreshedTask = db.taskMirror.getTask(task.id);
      expect(refreshedTask).toMatchObject({
        id: task.id,
        title: "Updated multi-target rollout",
        targets: [
          { repoKey: "common", branchName: "eng-4774", position: 0 },
          { repoKey: "lynk-frontend", branchName: "eng-4774", position: 1 },
          { repoKey: "web-front-door", branchName: "eng-4774", position: 2 },
        ],
      });

      const refreshedTargets = db.taskMirror.getTargetsForTask(task.id);
      expect(refreshedTargets.map((target) => target.id)).toEqual([
        targetIdsByRepo.get("common"),
        targetIdsByRepo.get("lynk-frontend"),
        targetIdsByRepo.get("web-front-door"),
      ]);

      const dependencyTargets = db.taskMirror.getTargetsForTask(dependencyTask.id);
      const dependencyIdsByRepo = new Map(dependencyTargets.map((target) => [target.repoKey, target.id]));
      expect(db.taskMirror.getTargetDependenciesForTask(task.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskTargetId: targetIdsByRepo.get("common"),
            dependsOnTaskTargetId: dependencyIdsByRepo.get("common"),
            position: 0,
            source: "derived",
          }),
          expect.objectContaining({
            taskTargetId: targetIdsByRepo.get("lynk-frontend"),
            dependsOnTaskTargetId: targetIdsByRepo.get("common"),
            position: 0,
            source: "metadata",
          }),
          expect.objectContaining({
            taskTargetId: targetIdsByRepo.get("lynk-frontend"),
            dependsOnTaskTargetId: dependencyIdsByRepo.get("lynk-frontend"),
            position: 0,
            source: "derived",
          }),
          expect.objectContaining({
            taskTargetId: targetIdsByRepo.get("web-front-door"),
            dependsOnTaskTargetId: targetIdsByRepo.get("common"),
            position: 1,
            source: "metadata",
          }),
        ]),
      );
      expect(db.taskMirror.getTargetDependenciesForTask(task.id)).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  test("preserves locally recorded pull requests across Linear task syncs", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);

    try {
      const task = {
        id: "ENG-4780",
        provider: "linear" as const,
        providerId: "issue-4780",
        title: "Targeted rollout",
        description: "Task",
        state: "in_review" as const,
        providerState: "In Review",
        priority: "high" as const,
        labels: ["Agent"],
        assignee: null,
        targets: [
          { repoKey: "common", branchName: "eng-4780", position: 0 },
          { repoKey: "sales-service", branchName: "eng-4780", position: 1 },
        ],
        targetDependencies: [],
        dependencies: { taskIds: [], baseTaskId: null },
        baseBranch: null,
        pullRequests: [],
        runnerOverride: null,
        updatedAt: "2026-03-18T12:05:00Z",
        url: "https://linear.app/acme/issue/ENG-4780",
      };

      db.taskMirror.saveTasks([task]);
      db.taskMirror.upsertTaskPullRequest({
        taskId: task.id,
        pullRequest: {
          repoKey: "sales-service",
          url: "https://github.com/acme/sales-service/pull/42",
          title: "PR 42",
          source: "local",
        },
      });

      db.taskMirror.saveTasks([{ ...task, title: "Refreshed targeted rollout" }]);

      expect(db.taskMirror.getTask(task.id)).toMatchObject({
        title: "Refreshed targeted rollout",
        pullRequests: [
          {
            repoKey: "sales-service",
            url: "https://github.com/acme/sales-service/pull/42",
            title: "PR 42",
            source: "local",
          },
        ],
      });
    } finally {
      db.close();
    }
  });
});

// The live-workspace safety guarantee of read-only consumers (eval-harvest)
// rests on these two pieces: assertMigrationsCurrent must refuse a DB that is
// behind (or diverged from) the checkout, and the readonly open must reject
// writes and missing files. Regressions here would silently mutate a DB owned
// by a running server.
describe("read-only workspace access", () => {
  test("assertMigrationsCurrent passes on a fully migrated DB, also via a readonly connection", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const dbPath = path.join(tempDir, "foreman.db");
    const db = await createMigratedDb(dbPath, projectRoot);
    db.close();

    const readonly = createRepos(await openSqliteDatabase(dbPath, { readonly: true }));
    try {
      await expect(readonly.migrationRunner.assertMigrationsCurrent(projectRoot)).resolves.toBeUndefined();
    } finally {
      readonly.close();
    }
  });

  test("assertMigrationsCurrent throws migrations_pending on an uninitialized DB (no schema_migration table)", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    // Writable open creates an empty DB file without running any migrations.
    const db = createRepos(await openSqliteDatabase(path.join(tempDir, "foreman.db")));
    try {
      await expect(db.migrationRunner.assertMigrationsCurrent(projectRoot)).rejects.toMatchObject({ code: "migrations_pending" });
    } finally {
      db.close();
    }
  });

  test("assertMigrationsCurrent throws migrations_pending naming the missing migration", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    try {
      db.database.sqlite.prepare("DELETE FROM schema_migration WHERE version = ?").run("0001_init_core.sql");
      await expect(db.migrationRunner.assertMigrationsCurrent(projectRoot)).rejects.toMatchObject({
        code: "migrations_pending",
        message: expect.stringContaining("0001_init_core.sql"),
      });
    } finally {
      db.close();
    }
  });

  test("assertMigrationsCurrent throws on a checksum that diverged from the shipped migration", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    try {
      db.database.sqlite.prepare("UPDATE schema_migration SET checksum = ? WHERE version = ?").run("tampered", "0001_init_core.sql");
      await expect(db.migrationRunner.assertMigrationsCurrent(projectRoot)).rejects.toMatchObject({ code: "migration_checksum_mismatch" });
    } finally {
      db.close();
    }
  });

  test("assertMigrationsCurrent tolerates a DB AHEAD of the checkout (documented as intentional)", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const db = await createMigratedDb(path.join(tempDir, "foreman.db"), projectRoot);
    try {
      // A stale checkout reading a newer live DB must not be blocked: migrations
      // are additive in practice (see assertMigrationsCurrent).
      db.database.sqlite
        .prepare("INSERT INTO schema_migration(version, checksum, applied_at) VALUES (?, ?, ?)")
        .run("9999_from_the_future.sql", "future-checksum", isoNow());
      await expect(db.migrationRunner.assertMigrationsCurrent(projectRoot)).resolves.toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("readonly open rejects writes and refuses a missing DB file", async () => {
    const tempDir = await createTempDir("foreman-db-test-");
    cleanupDirs.push(tempDir);
    const dbPath = path.join(tempDir, "foreman.db");
    const db = await createMigratedDb(dbPath, projectRoot);
    db.close();

    const readonly = await openSqliteDatabase(dbPath, { readonly: true });
    try {
      expect(() => readonly.sqlite.prepare("INSERT INTO schema_migration(version, checksum, applied_at) VALUES ('x', 'y', 'z')").run()).toThrow(
        /readonly/i,
      );
    } finally {
      readonly.close();
    }

    // fileMustExist: a readonly open must never create the DB.
    await expect(openSqliteDatabase(path.join(tempDir, "absent.db"), { readonly: true })).rejects.toThrow();
  });
});
