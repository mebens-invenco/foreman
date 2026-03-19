import { afterEach, describe, expect, test, vi } from "vitest";

import type { RepoRef, Task } from "../../domain/index.js";
import * as processLib from "../../lib/process.js";
import { GitHubReviewService } from "../index.js";

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

const sampleRepo: RepoRef = {
  key: "repo-a",
  rootPath: "/repos/repo-a",
  defaultBranch: "master",
};

const pullRequestSummaryResponse = jsonResponse({
  data: {
    repository: {
      pullRequest: {
        url: "https://github.com/acme/repo/pull/946",
        number: 946,
        state: "OPEN",
        isDraft: false,
        merged: false,
        headRefName: "eng-4737",
        baseRefName: "master",
      },
    },
  },
});

const emptyReviewSummariesResponse = jsonResponse({
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHubReviewService.getContext", () => {
  test("discovers an unlinked pull request by repo and branch before loading full context", async () => {
    vi.spyOn(processLib, "exec").mockResolvedValue({ stdout: "git@github.com:acme/repo.git\n", stderr: "", exitCode: 0 });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            html_url: "https://github.com/acme/repo/pull/946",
            number: 946,
            state: "open",
            draft: false,
            merged_at: null,
            head: { ref: "eng-4737" },
            base: { ref: "master" },
          },
        ]),
      )
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
                mergeable: "MERGEABLE",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T02:28:58Z" } }] },
                reviews: { nodes: [] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(emptyReviewSummariesResponse)
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
      .mockResolvedValueOnce(jsonResponse({ check_runs: [] }))
      .mockResolvedValueOnce(jsonResponse({ statuses: [] })) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    const context = await service.getContext(sampleTask({ artifacts: [] }), "[agent]", sampleRepo);

    expect(context).not.toBeNull();
    expect(context?.pullRequestUrl).toBe("https://github.com/acme/repo/pull/946");
    expect(context?.headBranch).toBe("eng-4737");
    expect(processLib.exec).toHaveBeenCalledWith("git", ["config", "--get", "remote.origin.url"], { cwd: "/repos/repo-a" });
    expect(global.fetch).toHaveBeenCalledTimes(7);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/repo/pulls?state=all&head=acme%3Aeng-4737&per_page=20",
    );
  });

  test("includes status contexts in failing and pending checks", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(pullRequestSummaryResponse)
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
                mergeable: "MERGEABLE",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T02:28:58Z" } }] },
                reviews: { nodes: [] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(emptyReviewSummariesResponse)
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
    expect(global.fetch).toHaveBeenCalledTimes(7);
    expect(vi.mocked(global.fetch).mock.calls[6]?.[0]).toBe("https://api.github.com/repos/acme/repo/commits/abc123/status");
  });

  test("maps dirty or conflicting pull requests to conflicting review state", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(pullRequestSummaryResponse)
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
                mergeStateStatus: "DIRTY",
                mergeable: "CONFLICTING",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T02:28:58Z" } }] },
                reviews: { nodes: [] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(emptyReviewSummariesResponse)
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
      .mockResolvedValueOnce(jsonResponse({ check_runs: [] }))
      .mockResolvedValueOnce(jsonResponse({ statuses: [] })) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    const context = await service.getContext(sampleTask(), "[agent]");

    expect(context).not.toBeNull();
    expect(context?.mergeState).toBe("conflicting");
  });

  test("enriches full review history across pages and preserves relevance flags", async () => {
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
      .mockResolvedValueOnce(pullRequestSummaryResponse)
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
                mergeable: "MERGEABLE",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T03:00:00Z" } }] },
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
                reviews: {
                  nodes: [
                    {
                      id: "review-1",
                      body: "Older review summary",
                      submittedAt: "2026-03-16T02:55:00Z",
                      author: { login: "reviewer-old" },
                      commit: { oid: "old-head" },
                    },
                    {
                      id: "review-2",
                      body: "Current-head summary",
                      submittedAt: "2026-03-16T03:30:00Z",
                      author: { login: "reviewer-current" },
                      commit: { oid: "abc123" },
                    },
                    {
                      id: "review-3",
                      body: "[agent] Addressed in latest head",
                      submittedAt: "2026-03-16T03:35:00Z",
                      author: { login: "foreman-bot" },
                      commit: { oid: "abc123" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
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
                      path: "src/three.ts",
                      line: 30,
                      comments: {
                        nodes: [
                          {
                            id: "thread-comment-4",
                            body: "[agent] Already handled",
                            createdAt: "2026-03-16T04:20:00Z",
                            url: "https://github.com/acme/repo/pull/946#discussion_r4",
                            author: { login: "foreman-bot" },
                          },
                        ],
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
    expect(context?.reviewSummaries).toEqual([
      {
        id: "review-1",
        body: "Older review summary",
        authorName: "reviewer-old",
        authoredByAgent: false,
        createdAt: "2026-03-16T02:55:00Z",
        commitId: "old-head",
        isCurrentHead: false,
      },
      {
        id: "review-2",
        body: "Current-head summary",
        authorName: "reviewer-current",
        authoredByAgent: false,
        createdAt: "2026-03-16T03:30:00Z",
        commitId: "abc123",
        isCurrentHead: true,
      },
      {
        id: "review-3",
        body: "[agent] Addressed in latest head",
        authorName: "foreman-bot",
        authoredByAgent: true,
        createdAt: "2026-03-16T03:35:00Z",
        commitId: "abc123",
        isCurrentHead: true,
      },
    ]);
    expect(context?.conversationComments).toHaveLength(102);
    expect(context?.conversationComments[0]).toMatchObject({
      id: "1",
      body: "Comment 1",
      authoredByAgent: false,
      isAfterCurrentHead: true,
      url: "https://github.com/acme/repo/pull/946#issuecomment-1",
    });
    expect(context?.conversationComments[100]).toMatchObject({
      id: "101",
      body: "[agent] noise",
      authoredByAgent: true,
      isAfterCurrentHead: true,
      url: "https://github.com/acme/repo/pull/946#issuecomment-101",
    });
    expect(context?.conversationComments[context.conversationComments.length - 1]).toMatchObject({
      id: "102",
      body: "Latest actionable comment",
      authoredByAgent: false,
      isAfterCurrentHead: true,
      url: "https://github.com/acme/repo/pull/946#issuecomment-102",
    });
    expect(context?.reviewThreads).toEqual([
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
            authoredByAgent: false,
            createdAt: "2026-03-16T04:00:00Z",
            url: "https://github.com/acme/repo/pull/946#discussion_r1",
          },
          {
            id: "thread-comment-2",
            body: "Follow-up detail",
            authorName: "reviewer-b",
            authoredByAgent: false,
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
            authoredByAgent: false,
            createdAt: "2026-03-16T04:10:00Z",
            url: "https://github.com/acme/repo/pull/946#discussion_r3",
          },
        ],
      },
      {
        id: "thread-3",
        path: "src/three.ts",
        line: 30,
        isResolved: true,
        comments: [
          {
            id: "thread-comment-4",
            body: "[agent] Already handled",
            authorName: "foreman-bot",
            authoredByAgent: true,
            createdAt: "2026-03-16T04:20:00Z",
            url: "https://github.com/acme/repo/pull/946#discussion_r4",
          },
        ],
      },
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(10);
    expect(vi.mocked(global.fetch).mock.calls[3]?.[0]).toBe("https://api.github.com/repos/acme/repo/issues/946/comments?per_page=100&page=1");
    expect(vi.mocked(global.fetch).mock.calls[4]?.[0]).toBe("https://api.github.com/repos/acme/repo/issues/946/comments?per_page=100&page=2");
  });

  test("ignores pending review summaries and draft review comments until the review is submitted", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(pullRequestSummaryResponse)
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
                mergeable: "MERGEABLE",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T03:00:00Z" } }] },
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
                reviews: {
                  nodes: [
                    {
                      id: "review-pending",
                      body: "Draft summary",
                      state: "PENDING",
                      submittedAt: null,
                      author: { login: "reviewer-draft" },
                      commit: { oid: "abc123" },
                    },
                    {
                      id: "review-submitted",
                      body: "Submitted summary",
                      state: "COMMENTED",
                      submittedAt: "2026-03-16T03:30:00Z",
                      author: { login: "reviewer-final" },
                      commit: { oid: "abc123" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
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
                  nodes: [
                    {
                      id: "thread-pending-only",
                      isResolved: false,
                      path: "src/one.ts",
                      line: 10,
                      comments: {
                        nodes: [
                          {
                            id: "thread-comment-pending",
                            body: "Draft inline note",
                            createdAt: "2026-03-16T04:00:00Z",
                            url: "https://github.com/acme/repo/pull/946#discussion_r1",
                            author: { login: "reviewer-draft" },
                            pullRequestReview: { state: "PENDING", submittedAt: null },
                          },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                    {
                      id: "thread-mixed",
                      isResolved: false,
                      path: "src/two.ts",
                      line: 22,
                      comments: {
                        nodes: [
                          {
                            id: "thread-comment-pending-2",
                            body: "Another draft inline note",
                            createdAt: "2026-03-16T04:05:00Z",
                            url: "https://github.com/acme/repo/pull/946#discussion_r2",
                            author: { login: "reviewer-draft" },
                            pullRequestReview: { state: "PENDING", submittedAt: null },
                          },
                          {
                            id: "thread-comment-submitted",
                            body: "Submitted inline note",
                            createdAt: "2026-03-16T04:10:00Z",
                            url: "https://github.com/acme/repo/pull/946#discussion_r3",
                            author: { login: "reviewer-final" },
                            pullRequestReview: { state: "COMMENTED", submittedAt: "2026-03-16T04:10:00Z" },
                          },
                        ],
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
    expect(context?.reviewSummaries).toEqual([
      {
        id: "review-submitted",
        body: "Submitted summary",
        authorName: "reviewer-final",
        authoredByAgent: false,
        createdAt: "2026-03-16T03:30:00Z",
        commitId: "abc123",
        isCurrentHead: true,
      },
    ]);
    expect(context?.reviewThreads).toEqual([
      {
        id: "thread-mixed",
        path: "src/two.ts",
        line: 22,
        isResolved: false,
        comments: [
          {
            id: "thread-comment-submitted",
            body: "Submitted inline note",
            authorName: "reviewer-final",
            authoredByAgent: false,
            createdAt: "2026-03-16T04:10:00Z",
            url: "https://github.com/acme/repo/pull/946#discussion_r3",
          },
        ],
      },
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(7);
  });
});

describe("GitHubReviewService reply mutations", () => {
  test("replies to review threads via GitHub GraphQL", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            addPullRequestReviewThreadReply: {
              comment: { id: "reply-1" },
            },
          },
        }),
      ) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await service.replyToThreadComment("https://github.com/acme/repo/pull/946", "thread-1", "[agent] Thanks");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe("https://api.github.com/graphql");
    const init = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      variables: { threadId: "thread-1", body: "[agent] Thanks" },
    });
  });
});
