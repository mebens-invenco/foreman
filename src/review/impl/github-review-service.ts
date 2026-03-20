import { ForemanError } from "../../lib/errors.js";
import { exec } from "../../lib/process.js";
import { LoggerService } from "../../logger.js";
import type { CheckState, ConversationComment, RepoRef, ResolvedPullRequest, ReviewComment, ReviewContext, ReviewThread, ReviewSummary, Task } from "../../domain/index.js";
import type { ReviewService } from "../review-service.js";

type RepoDescriptor = { owner: string; repo: string };

const parseGitHubUrl = (url: string): RepoDescriptor & { number: number } => {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) {
    throw new ForemanError("invalid_pr_url", `Invalid GitHub pull request URL: ${url}`);
  }

  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]!) };
};

const parseGitRemote = (remoteUrl: string): RepoDescriptor => {
  const trimmed = remoteUrl.trim();
  const httpsMatch = trimmed.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }

  throw new ForemanError("unsupported_git_remote", `Unsupported GitHub remote URL: ${remoteUrl}`);
};

type GitHubGraphqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type GitHubAuthor = { login: string | null } | null;

type GitHubGraphqlComment = {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: GitHubAuthor;
  pullRequestReview?: GitHubPullRequestReviewRef;
};

type GitHubPullRequestReviewNode = {
  id: string;
  body: string;
  state: string;
  submittedAt: string | null;
  author: GitHubAuthor;
  commit: { oid: string } | null;
};

type GitHubPullRequestReviewRef = {
  state: string;
  submittedAt: string | null;
} | null;

type GitHubRestIssueComment = {
  id: number;
  body: string;
  created_at: string;
  html_url?: string;
  user: { login: string | null } | null;
};

type GitHubRestPullRequest = {
  html_url: string;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  head: {
    ref: string;
  };
  base: {
    ref: string;
  };
};

type GitHubPullRequestMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;

type GitHubReviewThreadNode = {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  comments: {
    nodes: GitHubGraphqlComment[];
    pageInfo: PageInfo;
  };
};

const mergeCheckStates = (input: {
  checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
  statuses: Array<{ context: string; state: string }>;
}): { failingChecks: CheckState[]; pendingChecks: CheckState[] } => {
  const checksByName = new Map<string, CheckState>();
  const priority: Record<CheckState["state"], number> = { pending: 1, failure: 2 };

  const upsert = (name: string, state: CheckState["state"]): void => {
    const existing = checksByName.get(name);
    if (!existing || priority[state] > priority[existing.state]) {
      checksByName.set(name, { name, state });
    }
  };

  for (const check of input.checkRuns) {
    if (check.status === "completed") {
      if (check.conclusion && check.conclusion !== "success" && check.conclusion !== "neutral" && check.conclusion !== "skipped") {
        upsert(check.name, "failure");
      }
      continue;
    }

    upsert(check.name, "pending");
  }

  for (const status of input.statuses) {
    if (status.state === "failure" || status.state === "error") {
      upsert(status.context, "failure");
      continue;
    }

    if (status.state === "pending") {
      upsert(status.context, "pending");
    }
  }

  const checks = [...checksByName.values()].sort((left, right) => left.name.localeCompare(right.name) || left.state.localeCompare(right.state));
  return {
    failingChecks: checks.filter((check) => check.state === "failure"),
    pendingChecks: checks.filter((check) => check.state === "pending"),
  };
};

export class GitHubReviewService implements ReviewService {
  private readonly token: string;
  private readonly logger: LoggerService;
  private readonly repoDescriptorPromises = new Map<string, Promise<RepoDescriptor>>();

  constructor(env: Record<string, string>, logger?: LoggerService) {
    this.logger = (logger ?? LoggerService.create({ context: { component: "review.github" }, colorMode: "never" })).child({
      component: "review.github",
    });
    const token = env.GH_TOKEN;
    if (!token) {
      this.logger.error("GitHub review service initialization failed because GH_TOKEN is missing");
      throw new ForemanError("missing_github_token", "GH_TOKEN is required for GitHub review operations", 400);
    }

    this.token = token;
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const startedAt = Date.now();
    const method = init.method ?? "GET";
    this.logger.debug("sending GitHub REST request", { method, path });
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error("GitHub REST request failed", {
        method,
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      throw new ForemanError("github_request_failed", `GitHub request failed: ${response.status} ${body}`, 502);
    }

    if (response.status === 204) {
      this.logger.debug("GitHub REST request completed", { method, path, status: response.status, durationMs: Date.now() - startedAt });
      return undefined as T;
    }

    this.logger.debug("GitHub REST request completed", { method, path, status: response.status, durationMs: Date.now() - startedAt });
    return (await response.json()) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const startedAt = Date.now();
    const operationName = query.match(/\b(?:query|mutation)\s+(\w+)/)?.[1] ?? "anonymous";
    this.logger.debug("sending GitHub GraphQL request", {
      operationName,
      variableKeys: Object.keys(variables).sort().join(","),
    });
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error("GitHub GraphQL request failed", {
        operationName,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      throw new ForemanError("github_request_failed", `GitHub GraphQL request failed: ${response.status} ${body}`, 502);
    }

    const json = (await response.json()) as GitHubGraphqlResponse<T>;
    if (json.errors?.length) {
      this.logger.error("GitHub GraphQL request returned errors", {
        operationName,
        errorCount: json.errors.length,
        errors: json.errors.map((error) => error.message).join("; "),
        durationMs: Date.now() - startedAt,
      });
      throw new ForemanError(
        "github_request_failed",
        `GitHub GraphQL request failed: ${json.errors.map((error) => error.message).join("; ")}`,
        502,
      );
    }

    if (!json.data) {
      this.logger.error("GitHub GraphQL request returned no data", { operationName, durationMs: Date.now() - startedAt });
      throw new ForemanError("github_request_failed", "GitHub GraphQL response returned no data", 502);
    }

    this.logger.debug("GitHub GraphQL request completed", { operationName, durationMs: Date.now() - startedAt });
    return json.data;
  }

  private mapConversationComment(input: {
    id: string;
    body: string;
    createdAt: string;
    url?: string;
    author: GitHubAuthor;
    authoredByAgent: boolean;
  }): ReviewComment {
    return {
      id: input.id,
      body: input.body,
      authorName: input.author?.login ?? null,
      authoredByAgent: input.authoredByAgent,
      createdAt: input.createdAt,
      ...(input.url ? { url: input.url } : {}),
    };
  }

  private isAuthoredByAgent(body: string, agentPrefix: string): boolean {
    return body.startsWith(agentPrefix);
  }

  private isSubmittedReview(review: GitHubPullRequestReviewRef): boolean {
    return review ? review.state !== "PENDING" && Boolean(review.submittedAt) : true;
  }

  private async listPullRequestReviewSummaries(input: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
    agentPrefix: string;
  }): Promise<ReviewSummary[]> {
    const reviews: ReviewSummary[] = [];
    let cursor: string | null = null;

    while (true) {
      const data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: GitHubPullRequestReviewNode[];
              pageInfo: PageInfo;
            };
          } | null;
        } | null;
      } = await this.graphql(
        `query ForemanPullRequestReviews($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $cursor) {
                nodes {
                  id
                  body
                  state
                  submittedAt
                  author { login }
                  commit { oid }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }`,
        { owner: input.owner, repo: input.repo, number: input.number, cursor },
      );

      const reviewConnection = data.repository?.pullRequest?.reviews ?? null;
      if (!reviewConnection) {
        break;
      }

      reviews.push(
        ...reviewConnection.nodes
          .flatMap((review) =>
            Boolean(review.body?.trim()) && this.isSubmittedReview({ state: review.state, submittedAt: review.submittedAt }) && review.submittedAt
              ? [
                  {
                    id: review.id,
                    body: review.body,
                    authorName: review.author?.login ?? null,
                    authoredByAgent: this.isAuthoredByAgent(review.body, input.agentPrefix),
                    createdAt: review.submittedAt,
                    commitId: review.commit?.oid ?? "",
                    isCurrentHead: review.commit?.oid === input.headSha,
                  },
                ]
              : [],
          ),
      );

      if (!reviewConnection.pageInfo.hasNextPage) {
        break;
      }

      cursor = reviewConnection.pageInfo.endCursor;
    }

    reviews.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    return reviews;
  }

  private async listConversationCommentsByIssue(input: {
    owner: string;
    repo: string;
    number: number;
    headIntroducedAt: string;
    agentPrefix: string;
  }): Promise<ConversationComment[]> {
    const comments: ConversationComment[] = [];
    const headIntroducedAtMs = new Date(input.headIntroducedAt).getTime();

    for (let page = 1; ; page += 1) {
      const response = await this.rest<GitHubRestIssueComment[]>(
        `/repos/${input.owner}/${input.repo}/issues/${input.number}/comments?per_page=100&page=${page}`,
      );
      comments.push(
        ...response
          .filter((comment) => Boolean(comment.body?.trim()))
          .map((comment) => ({
            id: String(comment.id),
            body: comment.body,
            authorName: comment.user?.login ?? null,
            authoredByAgent: this.isAuthoredByAgent(comment.body, input.agentPrefix),
            createdAt: comment.created_at,
            isAfterCurrentHead: new Date(comment.created_at).getTime() >= headIntroducedAtMs,
            ...(comment.html_url ? { url: comment.html_url } : {}),
          })),
      );

      if (response.length < 100) {
        break;
      }
    }

    comments.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    return comments;
  }

  private async listReviewThreadComments(
    threadId: string,
    initialComments: GitHubGraphqlComment[],
    initialPageInfo: PageInfo,
    agentPrefix: string,
  ): Promise<ReviewComment[]> {
    const comments = initialComments
      .filter((comment) => Boolean(comment.body?.trim()) && this.isSubmittedReview(comment.pullRequestReview ?? null))
      .map((comment) => this.mapConversationComment({ ...comment, authoredByAgent: this.isAuthoredByAgent(comment.body, agentPrefix) }));
    let cursor = initialPageInfo.hasNextPage ? initialPageInfo.endCursor : null;

    while (cursor) {
      const data = await this.graphql<{
        node: {
          comments: {
            nodes: GitHubGraphqlComment[];
            pageInfo: PageInfo;
          };
        } | null;
      }>(
        `query ForemanReviewThreadComments($threadId: ID!, $cursor: String) {
          node(id: $threadId) {
            ... on PullRequestReviewThread {
              comments(first: 100, after: $cursor) {
                nodes {
                  id
                  body
                  createdAt
                  url
                  author { login }
                  pullRequestReview {
                    state
                    submittedAt
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }`,
        { threadId, cursor },
      );

      const thread = data.node;
      if (!thread) {
        break;
      }

      comments.push(
        ...thread.comments.nodes
          .filter((comment) => Boolean(comment.body?.trim()) && this.isSubmittedReview(comment.pullRequestReview ?? null))
          .map((comment) => this.mapConversationComment({ ...comment, authoredByAgent: this.isAuthoredByAgent(comment.body, agentPrefix) })),
      );
      cursor = thread.comments.pageInfo.hasNextPage ? thread.comments.pageInfo.endCursor : null;
    }

    return comments;
  }

  private async listReviewThreads(owner: string, repo: string, number: number, agentPrefix: string): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;

    while (true) {
      const data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: GitHubReviewThreadNode[];
              pageInfo: PageInfo;
            };
          } | null;
        } | null;
      } = await this.graphql(
        `query ForemanPullRequestReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                nodes {
                  id
                  isResolved
                  path
                  line
                  comments(first: 100) {
                    nodes {
                      id
                      body
                      createdAt
                      url
                      author { login }
                      pullRequestReview {
                        state
                        submittedAt
                      }
                    }
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }`,
        { owner, repo, number, cursor },
      );

      const reviewThreadConnection: { nodes: GitHubReviewThreadNode[]; pageInfo: PageInfo } | null =
        data.repository?.pullRequest?.reviewThreads ?? null;
      if (!reviewThreadConnection) {
        break;
      }

      for (const thread of reviewThreadConnection.nodes) {
        const comments = await this.listReviewThreadComments(thread.id, thread.comments.nodes, thread.comments.pageInfo, agentPrefix);
        if (comments.length === 0) {
          continue;
        }

        threads.push({
          id: thread.id,
          path: thread.path,
          line: thread.line,
          isResolved: thread.isResolved,
          comments,
        });
      }

      if (!reviewThreadConnection.pageInfo.hasNextPage) {
        break;
      }

      cursor = reviewThreadConnection.pageInfo.endCursor;
    }

    return threads;
  }

  private mapResolvedPullRequest(input: {
    url: string;
    number: number;
    state: "OPEN" | "CLOSED" | "MERGED" | "open" | "closed";
    merged: boolean;
    isDraft: boolean;
    headBranch: string;
    baseBranch: string;
  }): ResolvedPullRequest {
    return {
      pullRequestUrl: input.url,
      pullRequestNumber: input.number,
      state: input.merged ? "merged" : input.state === "OPEN" || input.state === "open" ? "open" : "closed",
      isDraft: input.isDraft,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
    };
  }

  private async pullRequestArtifact(task: Task, repo?: RepoRef): Promise<string | null> {
    const artifacts = task.artifacts.filter((artifact) => artifact.type === "pull_request");
    if (artifacts.length === 0) {
      return null;
    }

    if (!repo) {
      return artifacts[0]?.url ?? null;
    }

    const descriptor = await this.repoDescriptorFromRepo(repo);
    const repoMatch = artifacts.find((artifact) => {
      if (artifact.repo) {
        return artifact.repo === repo.key;
      }

      try {
        const parsed = new URL(artifact.url);
        const [, owner, repoName] = parsed.pathname.split("/");
        return owner === descriptor.owner && repoName === descriptor.repo;
      } catch {
        return false;
      }
    });

    if (repoMatch) {
      return repoMatch.url;
    }

    return artifacts.length === 1 ? artifacts[0]!.url : null;
  }

  private async resolvePullRequestFromArtifact(prUrl: string, taskId: string): Promise<ResolvedPullRequest | null> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.debug("resolving GitHub pull request from task artifact", { taskId, owner, repo, pullRequestNumber: number });
    const data = await this.graphql<{
      repository: {
        pullRequest: {
          url: string;
          number: number;
          state: "OPEN" | "CLOSED" | "MERGED";
          isDraft: boolean;
          merged: boolean;
          headRefName: string;
          baseRefName: string;
        } | null;
      } | null;
    }>(
      `query ForemanPullRequestSummary($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            url
            number
            state
            isDraft
            merged
            headRefName
            baseRefName
          }
        }
      }`,
      { owner, repo, number },
    );

    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      this.logger.debug("GitHub pull request referenced by artifact was not found", { taskId, owner, repo, pullRequestNumber: number });
      return null;
    }

    return this.mapResolvedPullRequest({
      url: pullRequest.url,
      number: pullRequest.number,
      state: pullRequest.state,
      merged: pullRequest.merged,
      isDraft: pullRequest.isDraft,
      headBranch: pullRequest.headRefName,
      baseBranch: pullRequest.baseRefName,
    });
  }

  private async repoDescriptorFromRepo(repo: RepoRef): Promise<RepoDescriptor> {
    let promise = this.repoDescriptorPromises.get(repo.rootPath);
    if (!promise) {
      promise = this.repoDescriptorFromCwd(repo.rootPath);
      this.repoDescriptorPromises.set(repo.rootPath, promise);
    }
    return promise;
  }

  private async resolvePullRequestByBranch(task: Task, repo: RepoRef): Promise<ResolvedPullRequest | null> {
    if (!task.branchName) {
      this.logger.debug("skipping branch-based GitHub pull request lookup because task branch metadata is missing", {
        taskId: task.id,
        repoKey: repo.key,
      });
      return null;
    }

    const descriptor = await this.repoDescriptorFromRepo(repo);
    const query = new URLSearchParams({
      state: "all",
      head: `${descriptor.owner}:${task.branchName}`,
      per_page: "20",
    });
    this.logger.debug("resolving GitHub pull request by task branch", {
      taskId: task.id,
      repoKey: repo.key,
      owner: descriptor.owner,
      repo: descriptor.repo,
      branchName: task.branchName,
    });
    const pullRequests = await this.rest<GitHubRestPullRequest[]>(`/repos/${descriptor.owner}/${descriptor.repo}/pulls?${query.toString()}`);
    const bestMatch = pullRequests
      .filter((pullRequest) => pullRequest.head.ref === task.branchName)
      .sort((left, right) => {
        const leftRank = left.state === "open" ? 0 : left.merged_at ? 1 : 2;
        const rightRank = right.state === "open" ? 0 : right.merged_at ? 1 : 2;
        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }
        return right.number - left.number;
      })[0];

    if (!bestMatch) {
      this.logger.debug("no GitHub pull request matched task branch", {
        taskId: task.id,
        repoKey: repo.key,
        branchName: task.branchName,
      });
      return null;
    }

    return this.mapResolvedPullRequest({
      url: bestMatch.html_url,
      number: bestMatch.number,
      state: bestMatch.state,
      merged: Boolean(bestMatch.merged_at),
      isDraft: bestMatch.draft,
      headBranch: bestMatch.head.ref,
      baseBranch: bestMatch.base.ref,
    });
  }

  async resolvePullRequest(task: Task, repo?: RepoRef): Promise<ResolvedPullRequest | null> {
    const prUrl = await this.pullRequestArtifact(task, repo);
    if (prUrl) {
      return this.resolvePullRequestFromArtifact(prUrl, task.id);
    }

    if (!repo) {
      this.logger.debug("skipping GitHub pull request resolution because task has no artifact and no repo context", { taskId: task.id });
      return null;
    }

    return this.resolvePullRequestByBranch(task, repo);
  }

  async getContext(task: Task, agentPrefix: string, repo?: RepoRef): Promise<ReviewContext | null> {
    const resolvedPullRequest = await this.resolvePullRequest(task, repo);
    const effectivePrUrl = resolvedPullRequest?.pullRequestUrl ?? null;
    if (!effectivePrUrl) {
      this.logger.debug("skipping GitHub review context lookup because task has no resolvable pull request", { taskId: task.id });
      return null;
    }

    const { owner, repo: repoName, number } = parseGitHubUrl(effectivePrUrl);
    this.logger.debug("fetching GitHub pull request context", { taskId: task.id, owner, repo: repoName, pullRequestNumber: number });
    const data = await this.graphql<{
      repository: {
          pullRequest: {
            url: string;
            number: number;
            state: "OPEN" | "CLOSED" | "MERGED";
            isDraft: boolean;
            merged: boolean;
            headRefOid: string;
            headRefName: string;
            baseRefName: string;
            mergeStateStatus: string;
            mergeable: GitHubPullRequestMergeable;
            commits: { nodes: Array<{ commit: { committedDate: string } }> };
          } | null;
        } | null;
      }>(
      `query ForemanPullRequest($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            url
            number
            state
            isDraft
            merged
            headRefOid
            headRefName
            baseRefName
            mergeStateStatus
            mergeable
            commits(last: 1) { nodes { commit { committedDate } } }
          }
        }
      }`,
      { owner, repo: repoName, number },
    );

    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      this.logger.debug("GitHub pull request context not found", { taskId: task.id, owner, repo: repoName, pullRequestNumber: number });
      return null;
    }

    const headIntroducedAt = pullRequest.commits.nodes.at(-1)?.commit.committedDate ?? new Date().toISOString();
    const reviewSummaries = await this.listPullRequestReviewSummaries({
      owner,
      repo: repoName,
      number,
      headSha: pullRequest.headRefOid,
      agentPrefix,
    });
    const conversationComments = await this.listConversationCommentsByIssue({
      owner,
      repo: repoName,
      number,
      headIntroducedAt,
      agentPrefix,
    });
    const reviewThreads = await this.listReviewThreads(owner, repoName, number, agentPrefix);

    const checks = await this.rest<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(
      `/repos/${owner}/${repoName}/commits/${pullRequest.headRefOid}/check-runs`,
    );
    const statuses = await this.rest<{ statuses: Array<{ context: string; state: string }> }>(
      `/repos/${owner}/${repoName}/commits/${pullRequest.headRefOid}/status`,
    );

    const { failingChecks, pendingChecks } = mergeCheckStates({ checkRuns: checks.check_runs, statuses: statuses.statuses });

    this.logger.debug("fetched GitHub pull request context", {
      taskId: task.id,
      owner,
      repo: repoName,
      pullRequestNumber: pullRequest.number,
      state: pullRequest.merged ? "merged" : pullRequest.state === "OPEN" ? "open" : "closed",
      reviewSummaryCount: reviewSummaries.length,
      conversationCommentCount: conversationComments.length,
      reviewThreadCount: reviewThreads.length,
      failingCheckCount: failingChecks.length,
      pendingCheckCount: pendingChecks.length,
    });

    return {
      provider: "github",
      pullRequestUrl: pullRequest.url,
      pullRequestNumber: pullRequest.number,
      state: pullRequest.merged ? "merged" : pullRequest.state === "OPEN" ? "open" : "closed",
      isDraft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      headBranch: pullRequest.headRefName,
      baseBranch: pullRequest.baseRefName,
      headIntroducedAt,
      mergeState: this.mapMergeState(pullRequest.mergeStateStatus, pullRequest.mergeable),
      reviewSummaries,
      conversationComments,
      reviewThreads,
      failingChecks,
      pendingChecks,
    };
  }

  private mapMergeState(value: string, mergeable: GitHubPullRequestMergeable): ReviewContext["mergeState"] {
    if (mergeable === "CONFLICTING") {
      return "conflicting";
    }

    switch (value) {
      case "CLEAN":
      case "HAS_HOOKS":
      case "UNSTABLE":
        return "clean";
      case "DIRTY":
      case "CONFLICTING":
        return "conflicting";
      default:
        return "unknown";
    }
  }

  async findLatestOpenPullRequestBranch(task: Task, repo?: RepoRef): Promise<string | null> {
    const pullRequest = await this.resolvePullRequest(task, repo);
    const branch = pullRequest?.state === "open" ? pullRequest.headBranch : null;
    this.logger.debug("resolved latest open pull request branch", { taskId: task.id, branch: branch ?? null });
    return branch;
  }

  private async repoDescriptorFromCwd(cwd: string): Promise<RepoDescriptor> {
    this.logger.debug("resolving GitHub repository from git remote", { cwd });
    const remote = await exec("git", ["config", "--get", "remote.origin.url"], { cwd });
    const repo = parseGitRemote(remote.stdout);
    this.logger.debug("resolved GitHub repository from git remote", { cwd, owner: repo.owner, repo: repo.repo });
    return repo;
  }

  async createPullRequest(input: {
    cwd: string;
    title: string;
    body: string;
    draft: boolean;
    baseBranch: string;
    headBranch: string;
  }): Promise<{ url: string; number: number }> {
    const repo = await this.repoDescriptorFromCwd(input.cwd);
    this.logger.info("creating GitHub pull request", {
      cwd: input.cwd,
      owner: repo.owner,
      repo: repo.repo,
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      draft: input.draft,
      titleLength: input.title.length,
      bodyLength: input.body.length,
    });
    const result = await this.rest<{ html_url: string; number: number }>(`/repos/${repo.owner}/${repo.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        draft: input.draft,
        base: input.baseBranch,
        head: input.headBranch,
      }),
      headers: {
        "content-type": "application/json",
      },
    });
    this.logger.info("created GitHub pull request", { owner: repo.owner, repo: repo.repo, pullRequestUrl: result.html_url, pullRequestNumber: result.number });
    return { url: result.html_url, number: result.number };
  }

  async reopenPullRequest(input: {
    cwd: string;
    pullRequestUrl?: string;
    pullRequestNumber?: number;
    draft: boolean;
    title?: string;
    body?: string;
  }): Promise<{ url: string; number: number }> {
    const repo = await this.repoDescriptorFromCwd(input.cwd);
    const number = input.pullRequestNumber ?? (input.pullRequestUrl ? parseGitHubUrl(input.pullRequestUrl).number : null);
    if (!number) {
      this.logger.error("cannot reopen GitHub pull request because no target was provided", { cwd: input.cwd });
      throw new ForemanError("invalid_pr_target", "Reopen pull request requires a number or URL");
    }

    this.logger.info("reopening GitHub pull request", {
      cwd: input.cwd,
      owner: repo.owner,
      repo: repo.repo,
      pullRequestNumber: number,
      draft: input.draft,
      titleLength: input.title?.length ?? 0,
      bodyLength: input.body?.length ?? 0,
    });

    const pr = await this.rest<{ html_url: string; number: number }>(`/repos/${repo.owner}/${repo.repo}/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "open", title: input.title, body: input.body }),
      headers: { "content-type": "application/json" },
    });

    if (input.draft === false) {
      this.logger.info("reopened GitHub pull request", { owner: repo.owner, repo: repo.repo, pullRequestUrl: pr.html_url, pullRequestNumber: pr.number });
      return { url: pr.html_url, number: pr.number };
    }

    this.logger.info("reopened GitHub pull request", { owner: repo.owner, repo: repo.repo, pullRequestUrl: pr.html_url, pullRequestNumber: pr.number });
    return { url: pr.html_url, number: pr.number };
  }

  async replyToReviewSummary(prUrl: string, reviewId: string, body: string): Promise<void> {
    const { owner, repo } = parseGitHubUrl(prUrl);
    this.logger.info("replying to GitHub review summary", { owner, repo, reviewId, pullRequestUrl: prUrl, bodyLength: body.length });
    await this.rest(`/repos/${owner}/${repo}/pulls/${reviewId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
    }).catch(async () => {
      const issue = parseGitHubUrl(prUrl);
      this.logger.warn("falling back to issue comment while replying to GitHub review summary", {
        owner,
        repo,
        reviewId,
        pullRequestNumber: issue.number,
      });
      await this.rest(`/repos/${owner}/${repo}/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `In reply to review ${reviewId}:\n\n${body}` }),
        headers: { "content-type": "application/json" },
      });
    });
    this.logger.info("replied to GitHub review summary", { owner, repo, reviewId, pullRequestUrl: prUrl });
  }

  async replyToThreadComment(prUrl: string, threadId: string, body: string): Promise<void> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.info("replying to GitHub review thread", {
      owner,
      repo,
      pullRequestNumber: number,
      threadId,
      bodyLength: body.length,
    });
    await this.graphql(
      `mutation AddPullRequestReviewThreadReply($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment { id }
        }
      }`,
      { threadId, body },
    );
    this.logger.info("replied to GitHub review thread", { owner, repo, pullRequestNumber: number, threadId });
  }

  async replyToPrComment(prUrl: string, commentId: string, body: string): Promise<void> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.info("replying to GitHub pull request comment", {
      owner,
      repo,
      pullRequestNumber: number,
      commentId,
      bodyLength: body.length,
    });
    await this.rest(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
    });
    this.logger.info("replied to GitHub pull request comment", { owner, repo, pullRequestNumber: number, commentId });
  }

  async resolveThreads(prUrl: string, threadIds: string[]): Promise<void> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.info("resolving GitHub review threads", {
      owner,
      repo,
      pullRequestNumber: number,
      threadCount: threadIds.length,
    });
    for (const threadId of threadIds) {
      this.logger.debug("resolving GitHub review thread", { owner, repo, pullRequestNumber: number, threadId });
      await this.graphql(
        `mutation ResolveReviewThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
        }`,
        { threadId },
      );
    }
    this.logger.info("resolved GitHub review threads", { owner, repo, pullRequestNumber: number, threadCount: threadIds.length });
  }
}
