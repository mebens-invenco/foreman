import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { discoverCronJobs, parseCronIntervalMs } from "../cron-jobs.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("cron jobs", () => {
  test("parses interval-only frontmatter", () => {
    expect(parseCronIntervalMs("15m")).toBe(15 * 60_000);
    expect(parseCronIntervalMs("1h")).toBe(60 * 60_000);
    expect(parseCronIntervalMs("2d")).toBe(2 * 24 * 60 * 60_000);
    expect(() => parseCronIntervalMs("every hour")).toThrow(/Cron interval/);
  });

  test("discovers markdown jobs and optional enabled flags", async () => {
    const workspaceRoot = await createTempDir("foreman-cron-test-");
    cleanupDirs.push(workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "file");
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, "cron", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "cron", "enabled.md"), "---\ninterval: 15m\n---\nFind work.");
    await fs.writeFile(path.join(workspaceRoot, "cron", "nested", "disabled.md"), "---\ninterval: 1h\nenabled: false\n---\nSkip.");

    const jobs = await discoverCronJobs(config, paths);

    expect(jobs.map((job) => ({ id: job.id, enabled: job.enabled, interval: job.interval, body: job.body }))).toEqual([
      { id: "cron/enabled.md", enabled: true, interval: "15m", body: "Find work." },
      { id: "cron/nested/disabled.md", enabled: false, interval: "1h", body: "Skip." },
    ]);
  });
});
