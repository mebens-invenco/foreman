import { afterEach, describe, expect, test, vi } from "vitest";

import { actionableConversationComments, type RepoRef, type Task } from "../../domain/index.js";
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
  dependencies: { taskIds: [], baseTaskId: null },
  pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo/pull/946", title: "PR 946", source: "provider" }],
  updatedAt: "2026-03-16T04:19:52Z",
  url: null,
  ...overrides,
  targets:
    overrides.targets ??
    [{ repoKey: "repo-a", branchName: "eng-4737", position: 0 }],
  targetDependencies: overrides.targetDependencies ?? [],
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

const sampleRepoB: RepoRef = {
  key: "repo-b",
  rootPath: "/repos/repo-b",
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

const emptyReviewThreadsResponse = jsonResponse({
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
});

const timeoutError = (): Error => Object.assign(new Error("Timed out"), { name: "TimeoutError" });

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
    const context = await service.getContext(sampleTask({ pullRequests: [] }), "[agent]", sampleRepo);

    expect(context).not.toBeNull();
    expect(context?.pullRequestUrl).toBe("https://github.com/acme/repo/pull/946");
    expect(context?.headBranch).toBe("eng-4737");
    expect(processLib.exec).toHaveBeenCalledWith("git", ["config", "--get", "remote.origin.url"], { cwd: "/repos/repo-a" });
    expect(global.fetch).toHaveBeenCalledTimes(7);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/repo/pulls?state=all&head=acme%3Aeng-4737&per_page=20",
    );
  });

  test("prefers the latest open branch pull request over a stale linked pull request", async () => {
    vi.spyOn(processLib, "exec").mockResolvedValue({ stdout: "git@github.com:acme/repo.git\n", stderr: "", exitCode: 0 });
    global.fetch = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          html_url: "https://github.com/acme/repo/pull/987",
          number: 987,
          state: "closed",
          draft: false,
          merged_at: null,
          head: { ref: "eng-4737" },
          base: { ref: "master" },
        },
        {
          html_url: "https://github.com/acme/repo/pull/988",
          number: 988,
          state: "open",
          draft: true,
          merged_at: null,
          head: { ref: "eng-4737" },
          base: { ref: "master" },
        },
      ]),
    ) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    const resolved = await service.resolvePullRequest(
      sampleTask({ pullRequests: [{ repoKey: "repo-a", url: "https://github.com/acme/repo/pull/987", source: "provider" }] }),
      sampleRepo,
      { repoKey: "repo-a", branchName: "eng-4737", position: 0 },
    );

    expect(resolved).toMatchObject({
      pullRequestUrl: "https://github.com/acme/repo/pull/988",
      pullRequestNumber: 988,
      state: "open",
      isDraft: true,
      headBranch: "eng-4737",
      baseBranch: "master",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/repo/pulls?state=all&head=acme%3Aeng-4737&per_page=20",
    );
  });

  test("does not reuse another target's pull request when repo context differs", async () => {
    vi.spyOn(processLib, "exec").mockResolvedValue({ stdout: "git@github.com:acme/repo-b.git\n", stderr: "", exitCode: 0 });
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse([])) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    const resolved = await service.resolvePullRequest(
      sampleTask({
        targets: [
          { repoKey: "repo-a", branchName: "eng-4737", position: 0 },
          { repoKey: "repo-b", branchName: "eng-4737", position: 1 },
        ],
      }),
      sampleRepoB,
      { repoKey: "repo-b", branchName: "eng-4737", position: 1 },
    );

    expect(resolved).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/repo-b/pulls?state=all&head=acme%3Aeng-4737&per_page=20",
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

  test("retries transient REST failures when loading check runs", async () => {
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
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T02:28:58Z" } }] },
                reviews: { nodes: [] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(emptyReviewSummariesResponse)
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(emptyReviewThreadsResponse)
      .mockResolvedValueOnce(jsonResponse({ message: "Gateway Timeout" }, 504))
      .mockResolvedValueOnce(jsonResponse({ check_runs: [{ name: "unit tests", status: "completed", conclusion: "success" }] }))
      .mockResolvedValueOnce(jsonResponse({ statuses: [] })) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    const context = await service.getContext(sampleTask(), "[agent]");

    expect(context).not.toBeNull();
    expect(context?.failingChecks).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(8);
    expect(vi.mocked(global.fetch).mock.calls[5]?.[0]).toBe("https://api.github.com/repos/acme/repo/commits/abc123/check-runs");
    expect(vi.mocked(global.fetch).mock.calls[6]?.[0]).toBe("https://api.github.com/repos/acme/repo/commits/abc123/check-runs");
  });

  test("surfaces REST timeouts after exhausting retries", async () => {
    vi.spyOn(processLib, "exec").mockResolvedValue({ stdout: "git@github.com:acme/repo.git\n", stderr: "", exitCode: 0 });
    global.fetch = vi.fn().mockRejectedValue(timeoutError()) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await expect(service.resolvePullRequest(sampleTask({ pullRequests: [] }), sampleRepo)).rejects.toThrow("GitHub request timed out after 60000ms");

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test("does not retry non-transient REST failures", async () => {
    vi.spyOn(processLib, "exec").mockResolvedValue({ stdout: "git@github.com:acme/repo.git\n", stderr: "", exitCode: 0 });
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404)) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await expect(service.resolvePullRequest(sampleTask({ pullRequests: [] }), sampleRepo)).rejects.toThrow("GitHub request failed: 404");

    expect(global.fetch).toHaveBeenCalledTimes(1);
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

  test("treats legacy review-summary fallback comments as agent-authored", async () => {
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
      .mockResolvedValueOnce(emptyReviewSummariesResponse)
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 102,
            body: "In reply to review review-1:\n\n[agent] Addressed in latest head",
            created_at: "2026-03-16T03:30:00Z",
            html_url: "https://github.com/acme/repo/pull/946#issuecomment-102",
            user: { login: "foreman-bot" },
          },
        ]),
      )
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

    expect(context?.conversationComments).toEqual([
      {
        id: "102",
        body: "In reply to review review-1:\n\n[agent] Addressed in latest head",
        authorName: "foreman-bot",
        authoredByAgent: true,
        createdAt: "2026-03-16T03:30:00Z",
        isAfterCurrentHead: true,
        url: "https://github.com/acme/repo/pull/946#issuecomment-102",
      },
    ]);
  });

  test("marks Linear linkback comments as non-actionable automation", async () => {
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
                mergeStateStatus: "BLOCKED",
                mergeable: "MERGEABLE",
                commits: { nodes: [{ commit: { committedDate: "2026-03-16T03:00:00Z" } }] },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(emptyReviewSummariesResponse)
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 103,
            body: "<!-- linear-linkback -->\n<details><summary>ENG-4959 Add wizard progress indicator</summary></details>",
            created_at: "2026-03-16T03:30:00Z",
            html_url: "https://github.com/acme/repo/pull/946#issuecomment-103",
            user: { login: "linear[bot]" },
          },
        ]),
      )
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

    expect(context?.conversationComments).toEqual([
      expect.objectContaining({
        id: "103",
        authorName: "linear[bot]",
        authoredByAgent: true,
        isAfterCurrentHead: true,
      }),
    ]);
    expect(context ? actionableConversationComments(context) : []).toEqual([]);
  });
});

describe("GitHubReviewService reply mutations", () => {
  test("submits comment reviews with inline comments via GitHub REST", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 1 }, 200)) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await service.submitPullRequestReview("https://github.com/acme/repo/pull/946", {
      body: "[review agent] Please tighten this validation.",
      event: "COMMENT",
      comments: [
        {
          path: "src/example.ts",
          line: 42,
          body: "[review agent] This branch is missing a null check.",
        },
      ],
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/repo/pulls/946/reviews");
    const init = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      body: "[review agent] Please tighten this validation.",
      event: "COMMENT",
      comments: [
        {
          path: "src/example.ts",
          line: 42,
          side: "RIGHT",
          body: "[review agent] This branch is missing a null check.",
        },
      ],
    });
  });

  test("deletes a stale pending review and retries when GitHub reports an existing pending review", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Validation Failed", errors: ["User can only have one pending review per pull request"] }, 422))
      .mockResolvedValueOnce(jsonResponse([{ id: 123, state: "PENDING" }]))
      .mockResolvedValueOnce(jsonResponse({ id: 123, state: "DISMISSED" }))
      .mockResolvedValueOnce(jsonResponse({ id: 124 }, 200)) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await service.submitPullRequestReview("https://github.com/acme/repo/pull/946", {
      body: "[review agent] Please tighten this validation.",
      event: "COMMENT",
      comments: [
        {
          path: "src/example.ts",
          line: 42,
          body: "[review agent] This branch is missing a null check.",
        },
      ],
    });

    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toBe("https://api.github.com/repos/acme/repo/pulls/946/reviews?per_page=100&page=1");
    expect(vi.mocked(global.fetch).mock.calls[2]?.[0]).toBe("https://api.github.com/repos/acme/repo/pulls/946/reviews/123");
    expect((vi.mocked(global.fetch).mock.calls[2]?.[1] as RequestInit).method).toBe("DELETE");

    const retryInit = vi.mocked(global.fetch).mock.calls[3]?.[1] as RequestInit;
    expect(JSON.parse(String(retryInit.body))).toEqual({
      body: "[review agent] Please tighten this validation.",
      event: "COMMENT",
      comments: [
        {
          path: "src/example.ts",
          line: 42,
          side: "RIGHT",
          body: "[review agent] This branch is missing a null check.",
        },
      ],
    });
  });

  test("does not retry unrelated GitHub review validation failures", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ message: "Validation Failed", errors: ["Some other 422"] }, 422)) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await expect(
      service.submitPullRequestReview("https://github.com/acme/repo/pull/946", {
        body: "[review agent] Please tighten this validation.",
        event: "COMMENT",
        comments: [
          {
            path: "src/example.ts",
            line: 42,
            body: "[review agent] This branch is missing a null check.",
          },
        ],
      }),
    ).rejects.toThrow("GitHub request failed: 422");

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("falls back to a body-only review when GitHub cannot resolve an inline comment line", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Validation Failed", errors: ["Line could not be resolved"] }, 422))
      .mockResolvedValueOnce(jsonResponse({ id: 1 }, 200)) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await service.submitPullRequestReview("https://github.com/acme/repo/pull/946", {
      body: "[review agent] Please tighten this validation.",
      event: "COMMENT",
      comments: [
        {
          path: "src/example.ts",
          line: 42,
          body: "[review agent] This branch is missing a null check.",
        },
      ],
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toBe("https://api.github.com/repos/acme/repo/pulls/946/reviews");
    const retryInit = vi.mocked(global.fetch).mock.calls[1]?.[1] as RequestInit;
    const retryBody = JSON.parse(String(retryInit.body));
    expect(retryBody).toEqual({
      body: expect.stringContaining("GitHub rejected one or more inline review comment locations as unresolvable"),
      event: "COMMENT",
    });
    expect(retryBody.body).toContain("Location: `src/example.ts:42` (RIGHT)");
    expect(retryBody.body).toContain("[review agent] This branch is missing a null check.");
  });

  test("posts review-summary replies as prefixed top-level comments", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 1 }, 201)) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await service.replyToReviewSummary("https://github.com/acme/repo/pull/946", "review-1", "[agent] Thanks");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(global.fetch).mock.calls[0]?.[0]).toBe("https://api.github.com/repos/acme/repo/issues/946/comments");
    const init = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ body: "[agent] Thanks\n\nIn reply to review review-1." });
  });

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

  test("retries GraphQL timeouts before succeeding", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(timeoutError())
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

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(global.fetch).mock.calls[1]?.[0]).toBe("https://api.github.com/graphql");
  });

  test("surfaces transient GraphQL failures after exhausting retries", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ message: "Service Unavailable" }, 503)) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await expect(service.replyToThreadComment("https://github.com/acme/repo/pull/946", "thread-1", "[agent] Thanks")).rejects.toThrow(
      "GitHub GraphQL request failed: 503",
    );

    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test("does not retry GraphQL semantic errors", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Could not resolve to a node" }] })) as typeof fetch;

    const service = new GitHubReviewService({ GH_TOKEN: "test-token" }, fakeLogger as any);
    await expect(service.replyToThreadComment("https://github.com/acme/repo/pull/946", "thread-1", "[agent] Thanks")).rejects.toThrow(
      "GitHub GraphQL request failed: Could not resolve to a node",
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
