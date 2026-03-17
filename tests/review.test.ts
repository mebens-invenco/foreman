import { afterEach, describe, expect, test, vi } from "vitest";

import type { Task } from "../src/domain.js";
import { GitHubReviewService } from "../src/review/index.js";

const fakeLogger = {
  child() {
    return this;
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const sampleTask = (overrides: Partial<Task> = {}): Task => ({
  id: "ENG-4737",
  provider: "linear",
  providerId: "ENG-4737",
  title: "Review task",
  description: "",
  state: "in_review",
  providerState: "In Review",
  priority: "normal",
  labels: ["Agent"],
  assignee: null,
  repo: "lynk-frontend",
  branchName: "eng-4737",
  dependencies: { taskIds: [], baseTaskId: null, branchNames: [] },
  artifacts: [{ type: "pull_request", url: "https://github.com/acme/repo/pull/946", title: "PR 946" }],
  updatedAt: "2026-03-16T04:19:52Z",
  url: null,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHubReviewService.getContext", () => {
  test("includes status contexts in failing and pending checks", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                url: "https://github.com/acme/repo/pull/946",
                number: 946,
                state: "OPEN",
                isDraft: true,
                merged: false,
                headRefOid: "abc123",
                headRefName: "eng-4737",
                baseRefName: "master",
                mergeStateStatus: "UNSTABLE",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T02:28:58Z" } }] },
                reviews: { nodes: [] },
                comments: { nodes: [] },
                reviewThreads: { nodes: [] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          check_runs: [
            { name: "task-list-completed", status: "in_progress", conclusion: null },
            { name: "unit tests", status: "completed", conclusion: "failure" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          statuses: [
            { context: "ci/circleci: Prepare dependencies", state: "failure" },
            { context: "task-list-completed", state: "pending" },
            { context: "unit tests", state: "success" },
          ],
        }),
      ) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    const context = await service.getContext(sampleTask(), "[agent]");

    expect(context).not.toBeNull();
    expect(context?.failingChecks).toEqual([
      { name: "ci/circleci: Prepare dependencies", state: "failure" },
      { name: "unit tests", state: "failure" },
    ]);
    expect(context?.pendingChecks).toEqual([{ name: "task-list-completed", state: "pending" }]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(global.fetch).mock.calls[2]?.[0]).toBe("https://api.github.com/repos/acme/repo/commits/abc123/status");
  });
});
