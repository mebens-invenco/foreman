import { Writable } from "node:stream";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { LoggerService } from "../../logger.js";
import type { ForemanRepos } from "../../repos/index.js";
import { createMigratedDb, createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";
import { SlackProblemNotifier } from "../problem-notifier.js";

const cleanupDirs: string[] = [];
const nullWritable = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const createAttempt = (db: ForemanRepos, suffix: string) => {
  db.workers.ensureWorkerSlots(1);
  const job = db.jobs.createCronJob({
    cronJobId: "cron/check.md",
    dedupeKey: `cron:check:${suffix}`,
    selectionReason: "test",
  });
  return db.attempts.createAttempt({
    jobId: job.id,
    workerId: db.workers.listWorkers()[0]!.id,
    runnerName: "opencode",
    runnerModel: "test",
    runnerVariant: "test",
  });
};

describe("SlackProblemNotifier", () => {
  test("suppresses the same persisted problem for one hour across restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
    const workspaceRoot = await createTempDir("foreman-slack-notifier-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    const send = vi.fn(async () => ({ channelId: "D123", messageTs: "123.456" }));
    const input = {
      subjectKey: "target-1",
      subject: "ENG-1",
      action: "execution" as const,
      status: "failed" as const,
      summary: "Runner failed.",
      url: "https://linear.app/example/ENG-1",
    };

    const firstDb = await createMigratedDb(paths.dbPath, testProjectRoot);
    const firstAttempt = createAttempt(firstDb, "first");
    await new SlackProblemNotifier({
      attempts: firstDb.attempts,
      isConfigured: () => true,
      send,
      logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
    }).notify({ ...input, attemptId: firstAttempt.id });
    expect(firstDb.attempts.listAttemptEvents(firstAttempt.id).at(-1)?.payload).toEqual({
      channelId: "D123",
      fingerprint: expect.any(String),
      messageTs: "123.456",
    });
    expect(send).toHaveBeenCalledWith("Foreman execution failed for <https://linear.app/example/ENG-1|ENG-1>.\nRunner failed.");
    firstDb.close();

    const secondDb = await createMigratedDb(paths.dbPath, testProjectRoot);
    try {
      const secondAttempt = createAttempt(secondDb, "second");
      await new SlackProblemNotifier({
        attempts: secondDb.attempts,
        isConfigured: () => true,
        send,
        logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
      }).notify({ ...input, attemptId: secondAttempt.id });

      expect(send).toHaveBeenCalledOnce();
      expect(secondDb.attempts.listAttemptEvents(secondAttempt.id).at(-1)?.eventType).toBe("slack_notification_suppressed");

      vi.setSystemTime(new Date("2026-08-20T13:01:00.000Z"));
      const thirdAttempt = createAttempt(secondDb, "third");
      await new SlackProblemNotifier({
        attempts: secondDb.attempts,
        isConfigured: () => true,
        send,
        logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
      }).notify({ ...input, attemptId: thirdAttempt.id });
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      secondDb.close();
    }
  });

  test("records delivery errors without rejecting or notifying non-problem statuses", async () => {
    const workspaceRoot = await createTempDir("foreman-slack-notifier-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    const db = await createMigratedDb(path.join(workspaceRoot, "foreman.db"), testProjectRoot);
    const send = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    try {
      const failedAttempt = createAttempt(db, "failed");
      const completedAttempt = createAttempt(db, "completed");
      const notifier = new SlackProblemNotifier({
        attempts: db.attempts,
        isConfigured: () => true,
        send,
        logger: LoggerService.create({ paths, stdout: nullWritable, minLevel: "error" }),
      });

      await expect(notifier.notify({
        attemptId: failedAttempt.id,
        subjectKey: "target-1",
        subject: "ENG-1",
        action: "review",
        status: "blocked",
        summary: "Review blocked.",
      })).resolves.toBeUndefined();
      await notifier.notify({
        attemptId: completedAttempt.id,
        subjectKey: "target-1",
        subject: "ENG-1",
        action: "review",
        status: "completed",
        summary: "Review complete.",
      });
      const repeatedAttempt = createAttempt(db, "repeated");
      await notifier.notify({
        attemptId: repeatedAttempt.id,
        subjectKey: "target-1",
        subject: "ENG-1",
        action: "review",
        status: "blocked",
        summary: "Review blocked.",
      });

      expect(send).toHaveBeenCalledOnce();
      const event = db.attempts.listAttemptEvents(failedAttempt.id).at(-1)!;
      expect(event.eventType).toBe("slack_notification_failed");
      expect(event.payload).toEqual({ fingerprint: expect.any(String), error: "delivery failed" });
      expect(db.attempts.listAttemptEvents(completedAttempt.id)).toEqual([]);
      expect(db.attempts.listAttemptEvents(repeatedAttempt.id).at(-1)?.eventType).toBe("slack_notification_suppressed");
    } finally {
      db.close();
    }
  });
});
