import { afterEach, describe, expect, test, vi } from "vitest";

import type { Task } from "../src/domain.js";
import { GitHubReviewService } from "../src/review.js";

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
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
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
    expect(global.fetch).toHaveBeenCalledTimes(5);
    expect(vi.mocked(global.fetch).mock.calls[4]?.[0]).toBe("https://api.github.com/repos/acme/repo/commits/abc123/status");
  });

  test("enriches actionable comments and unresolved threads across pages", async () => {
    const pageOneComments = Array.from({ length: 100 }, (_, index) => {
      const hour = 3 + Math.floor(index / 60);
      const minute = index % 60;
      return {
        id: index + 1,
        body: `Comment ${index + 1}`,
        created_at: `2026-03-16T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
        html_url: `https://github.com/acme/repo/pull/946#issuecomment-${index + 1}`,
        user: { login: `reviewer-${index + 1}` },
      };
    });

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
                isDraft: false,
                merged: false,
                headRefOid: "abc123",
                headRefName: "eng-4737",
                baseRefName: "master",
                mergeStateStatus: "CLEAN",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T03:00:00Z" } }] },
                reviews: { nodes: [] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(pageOneComments))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 101,
            body: "[agent] noise",
            created_at: "2026-03-16T04:40:00Z",
            html_url: "https://github.com/acme/repo/pull/946#issuecomment-101",
            user: { login: "foreman-bot" },
          },
          {
            id: 102,
            body: "Latest actionable comment",
            created_at: "2026-03-16T04:41:00Z",
            html_url: "https://github.com/acme/repo/pull/946#issuecomment-102",
            user: { login: "reviewer-latest" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      path: "src/one.ts",
                      line: 10,
                      comments: {
                        nodes: [
                          {
                            id: "thread-comment-1",
                            body: "Please adjust this",
                            createdAt: "2026-03-16T04:00:00Z",
                            url: "https://github.com/acme/repo/pull/946#discussion_r1",
                            author: { login: "reviewer-a" },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "thread-comment-page-2" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "thread-page-2" },
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            node: {
              comments: {
                nodes: [
                  {
                    id: "thread-comment-2",
                    body: "Follow-up detail",
                    createdAt: "2026-03-16T04:05:00Z",
                    url: "https://github.com/acme/repo/pull/946#discussion_r2",
                    author: { login: "reviewer-b" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-2",
                      isResolved: false,
                      path: "src/two.ts",
                      line: 22,
                      comments: {
                        nodes: [
                          {
                            id: "thread-comment-3",
                            body: "Second thread",
                            createdAt: "2026-03-16T04:10:00Z",
                            url: "https://github.com/acme/repo/pull/946#discussion_r3",
                            author: { login: "reviewer-c" },
                          },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                    {
                      id: "thread-3",
                      isResolved: true,
                      path: "src/ignored.ts",
                      line: 30,
                      comments: {
                        nodes: [],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ check_runs: [] }))
      .mockResolvedValueOnce(jsonResponse({ statuses: [] })) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    const context = await service.getContext(sampleTask(), "[agent]");

    expect(context).not.toBeNull();
    expect(context?.actionableConversationComments).toHaveLength(101);
    expect(context?.actionableConversationComments[0]).toMatchObject({
      id: "1",
      body: "Comment 1",
      url: "https://github.com/acme/repo/pull/946#issuecomment-1",
    });
    expect(context?.actionableConversationComments[context.actionableConversationComments.length - 1]).toMatchObject({
      id: "102",
      body: "Latest actionable comment",
      url: "https://github.com/acme/repo/pull/946#issuecomment-102",
    });
    expect(context?.unresolvedThreads).toEqual([
      {
        id: "thread-1",
        path: "src/one.ts",
        line: 10,
        isResolved: false,
        comments: [
          {
            id: "thread-comment-1",
            body: "Please adjust this",
            authorName: "reviewer-a",
            createdAt: "2026-03-16T04:00:00Z",
            url: "https://github.com/acme/repo/pull/946#discussion_r1",
          },
          {
            id: "thread-comment-2",
            body: "Follow-up detail",
            authorName: "reviewer-b",
            createdAt: "2026-03-16T04:05:00Z",
            url: "https://github.com/acme/repo/pull/946#discussion_r2",
          },
        ],
      },
      {
        id: "thread-2",
        path: "src/two.ts",
        line: 22,
        isResolved: false,
        comments: [
          {
            id: "thread-comment-3",
            body: "Second thread",
            authorName: "reviewer-c",
            createdAt: "2026-03-16T04:10:00Z",
            url: "https://github.com/acme/repo/pull/946#discussion_r3",
          },
        ],
      },
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(8);
    expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toBe("https://api.github.com/repos/acme/repo/issues/946/comments?per_page=100&page=1");
    expect(vi.mocked(global.fetch).mock.calls[2]?.[0]).toBe("https://api.github.com/repos/acme/repo/issues/946/comments?per_page=100&page=2");
  });
});
