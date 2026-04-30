import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { createTempDir, createWorkspacePaths, testProjectRoot } from "../../test-support/helpers.js";
import { createDefaultWorkspaceConfig } from "../../workspace/config.js";
import { renderCronPrompt } from "../render-cron-prompt.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("renderCronPrompt", () => {
  test("renders analysis-only policy and plan context", async () => {
    const workspaceRoot = await createTempDir("foreman-cron-prompt-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "plan.md"), "# Plan\n\nDo useful work.");
    const config = createDefaultWorkspaceConfig("foo", "linear");

    const prompt = await renderCronPrompt({
      config,
      paths,
      repos: [{ key: "repo-a", rootPath: "/repos/repo-a", defaultBranch: "main" }],
      job: {
        id: "cron/check.md",
        title: "check",
        absolutePath: path.join(workspaceRoot, "cron", "check.md"),
        relativePath: "cron/check.md",
        intervalMs: 900_000,
        interval: "15m",
        enabled: true,
        body: "Inspect the plan.",
      },
    });

    expect(prompt).toContain("Do useful work.");
    expect(prompt).toContain("Do not create provider tasks");
    expect(prompt).toContain("Natural-language output is valid");
  });

  test("renders Linear task creation guidance without token values", async () => {
    const workspaceRoot = await createTempDir("foreman-cron-prompt-test-");
    cleanupDirs.push(workspaceRoot);
    const paths = createWorkspacePaths(testProjectRoot, workspaceRoot);
    const config = createDefaultWorkspaceConfig("foo", "linear");
    config.agentTaskCreation.enabled = true;

    const prompt = await renderCronPrompt({
      config,
      paths,
      repos: [],
      job: {
        id: "cron/check.md",
        title: "check",
        absolutePath: path.join(workspaceRoot, "cron", "check.md"),
        relativePath: "cron/check.md",
        intervalMs: 900_000,
        interval: "15m",
        enabled: true,
        body: "Create follow-ups when useful.",
      },
    });

    expect(prompt).toContain("LINEAR_API_KEY");
    expect(prompt).toContain("never print, log, or expose its value");
  });
});
