import { ForemanError } from "../../lib/errors.js";
import { createTimeoutSignal, isAbortLikeError, PROVIDER_REQUEST_TIMEOUT_MS } from "../../lib/fetch-timeout.js";
import { exec } from "../../lib/process.js";
import { LoggerService } from "../../logger.js";
import {
  resolveTaskBranchName,
  resolveTaskPullRequest,
  resolveTaskTargetRef,
  type CheckState,
  type ConversationComment,
  type RepoRef,
  type ResolvedPullRequest,
  type ReviewComment,
  type ReviewContext,
  type ReviewThread,
  type ReviewSummary,
  type Task,
  type TaskTargetRef,
} from "../../domain/index.js";
import type { ReviewService } from "../review-service.js";

type RepoDescriptor = { owner: string; repo: string };

type PullRequestReviewInlineComment = {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
};

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

const isUnresolvableReviewCommentError = (error: unknown): boolean =>
  error instanceof ForemanError && error.message.includes("GitHub request failed: 422") && error.message.includes("Line could not be resolved");

const isExistingPendingReviewError = (error: unknown): boolean =>
  error instanceof ForemanError &&
  error.message.includes("GitHub request failed: 422") &&
  error.message.includes("User can only have one pending review per pull request");

const fallbackReviewBodyForUnresolvableComments = (body: string, comments: PullRequestReviewInlineComment[]): string => {
  const inlineFeedback = comments
    .map((comment, index) => {
      const side = comment.side ?? "RIGHT";
      return [`### Inline comment ${index + 1}`, `Location: \`${comment.path}:${comment.line}\` (${side})`, "", comment.body].join("\n");
    })
    .join("\n\n");

  return [
    body,
    "GitHub rejected one or more inline review comment locations as unresolvable, so Foreman is preserving the inline feedback here instead.",
    inlineFeedback,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
};

type GitHubGraphqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

type GitHubRequestKind = "REST" | "GraphQL";

type GitHubRequestContext =
  | { kind: "REST"; method: string; path: string }
  | { kind: "GraphQL"; operationName: string };

type GitHubRateLimitHeaders = {
  limit: string | null;
  remaining: string | null;
  reset: string | null;
  resource: string | null;
  retryAfter: string | null;
};

const LOW_RATE_LIMIT_REMAINING_THRESHOLD = 10;
const DEFAULT_SECONDARY_RATE_LIMIT_BACKOFF_MS = 60_000;

const parseHeaderInteger = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const rateLimitResetMs = (headers: GitHubRateLimitHeaders): number | null => {
  const resetSeconds = parseHeaderInteger(headers.reset);
  return resetSeconds === null ? null : resetSeconds * 1000;
};

const retryAfterMs = (headers: GitHubRateLimitHeaders): number | null => {
  const retryAfterSeconds = parseHeaderInteger(headers.retryAfter);
  return retryAfterSeconds === null ? null : retryAfterSeconds * 1000;
};

const formatResetAt = (resetMs: number | null): string | null => (resetMs === null ? null : new Date(resetMs).toISOString());

const rateLimitHeadersFromResponse = (response: Response): GitHubRateLimitHeaders => {
  const headers = (response as { headers?: Headers }).headers;
  return {
    limit: headers?.get("x-ratelimit-limit") ?? null,
    remaining: headers?.get("x-ratelimit-remaining") ?? null,
    reset: headers?.get("x-ratelimit-reset") ?? null,
    resource: headers?.get("x-ratelimit-resource") ?? null,
    retryAfter: headers?.get("retry-after") ?? null,
  };
};

const hasRateLimitHeaders = (headers: GitHubRateLimitHeaders): boolean =>
  Boolean(headers.limit ?? headers.remaining ?? headers.reset ?? headers.resource);

const operationLogContext = (context: GitHubRequestContext): Record<string, string | number | boolean | null> =>
  context.kind === "REST" ? { method: context.method, path: context.path } : { operationName: context.operationName };

const rateLimitLogContext = (
  context: GitHubRequestContext,
  headers: GitHubRateLimitHeaders,
): Record<string, string | number | boolean | null> => {
  const resetMs = rateLimitResetMs(headers);
  return {
    ...operationLogContext(context),
    rateLimitLimit: headers.limit,
    rateLimitRemaining: headers.remaining,
    rateLimitReset: headers.reset,
    rateLimitResetAt: formatResetAt(resetMs),
    rateLimitResource: headers.resource,
  };
};

const isGitHubRateLimitResponse = (status: number, body: string, headers: GitHubRateLimitHeaders): boolean => {
  const remaining = parseHeaderInteger(headers.remaining);
  const normalizedBody = body.toLowerCase();
  return (
    status === 429 ||
    (status === 403 &&
      (remaining === 0 || normalizedBody.includes("rate limit") || normalizedBody.includes("abuse detection mechanism")))
  );
};

const areGitHubGraphqlRateLimitErrors = (errors: Array<{ message: string }>): boolean =>
  errors.some((error) => {
    const message = error.message.toLowerCase();
    return message.includes("rate limit") || message.includes("abuse detection mechanism");
  });

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

type GitHubRestPullRequestReview = {
  id: number;
  state: string;
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
  private readonly rateLimitBackoffUntilByKind = new Map<GitHubRequestKind, { untilMs: number; resource: string | null }>();

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

  private throwIfRateLimited(context: GitHubRequestContext): void {
    const backoff = this.rateLimitBackoffUntilByKind.get(context.kind);
    if (!backoff) {
      return;
    }

    const now = Date.now();
    if (backoff.untilMs <= now) {
      this.rateLimitBackoffUntilByKind.delete(context.kind);
      return;
    }

    const resetAt = new Date(backoff.untilMs).toISOString();
    this.logger.warn("skipping GitHub request during rate-limit backoff", {
      ...operationLogContext(context),
      rateLimitResource: backoff.resource,
      rateLimitResetAt: resetAt,
    });
    throw new ForemanError("github_rate_limit_exceeded", `GitHub ${context.kind} rate limit is active until ${resetAt}`, 429);
  }

  private logRateLimitHeaders(context: GitHubRequestContext, headers: GitHubRateLimitHeaders): void {
    if (!hasRateLimitHeaders(headers)) {
      return;
    }

    this.logger.debug(`received GitHub ${context.kind} rate-limit headers`, rateLimitLogContext(context, headers));

    const remaining = parseHeaderInteger(headers.remaining);
    if (remaining !== null && remaining > 0 && remaining <= LOW_RATE_LIMIT_REMAINING_THRESHOLD) {
      this.logger.warn("GitHub rate-limit remaining quota is low", rateLimitLogContext(context, headers));
    }
  }

  private rememberRateLimitBackoff(context: GitHubRequestContext, headers: GitHubRateLimitHeaders): string | null {
    const retryMs = retryAfterMs(headers);
    const untilMs = retryMs === null ? (rateLimitResetMs(headers) ?? Date.now() + DEFAULT_SECONDARY_RATE_LIMIT_BACKOFF_MS) : Date.now() + retryMs;
    if (untilMs <= Date.now()) {
      return formatResetAt(untilMs);
    }

    this.rateLimitBackoffUntilByKind.set(context.kind, { untilMs, resource: headers.resource });
    return new Date(untilMs).toISOString();
  }

  private throwRateLimitError(input: {
    context: GitHubRequestContext;
    status: number;
    body: string;
    headers: GitHubRateLimitHeaders;
    durationMs: number;
  }): never {
    const resetAt = this.rememberRateLimitBackoff(input.context, input.headers);
    this.logger.error(`GitHub ${input.context.kind} request rate limited`, {
      ...rateLimitLogContext(input.context, input.headers),
      status: input.status,
      durationMs: input.durationMs,
      rateLimitResetAt: resetAt,
    });
    const resetSuffix = resetAt ? ` until ${resetAt}` : "";
    throw new ForemanError(
      "github_rate_limit_exceeded",
      `GitHub ${input.context.kind} rate limit exceeded${resetSuffix}: ${input.status} ${input.body}`,
      429,
    );
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const startedAt = Date.now();
    const method = init.method ?? "GET";
    const requestContext: GitHubRequestContext = { kind: "REST", method, path };
    this.throwIfRateLimited(requestContext);
    this.logger.debug("sending GitHub REST request", { method, path });
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          ...(init.headers ?? {}),
        },
        signal: createTimeoutSignal(PROVIDER_REQUEST_TIMEOUT_MS, init.signal ? [init.signal] : []),
      });
    } catch (error) {
      if (isAbortLikeError(error)) {
        this.logger.error("GitHub REST request timed out", {
          method,
          path,
          durationMs: Date.now() - startedAt,
          timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
        });
        throw new ForemanError("github_request_timeout", `GitHub request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS}ms`, 504);
      }
      throw error;
    }

    const rateLimitHeaders = rateLimitHeadersFromResponse(response);
    this.logRateLimitHeaders(requestContext, rateLimitHeaders);

    if (!response.ok) {
      const body = await response.text();
      if (isGitHubRateLimitResponse(response.status, body, rateLimitHeaders)) {
        this.throwRateLimitError({
          context: requestContext,
          status: response.status,
          body,
          headers: rateLimitHeaders,
          durationMs: Date.now() - startedAt,
        });
      }
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
    const requestContext: GitHubRequestContext = { kind: "GraphQL", operationName };
    this.throwIfRateLimited(requestContext);
    this.logger.debug("sending GitHub GraphQL request", {
      operationName,
      variableKeys: Object.keys(variables).sort().join(","),
    });
    let response: Response;
    try {
      response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
        signal: createTimeoutSignal(),
      });
    } catch (error) {
      if (isAbortLikeError(error)) {
        this.logger.error("GitHub GraphQL request timed out", {
          operationName,
          durationMs: Date.now() - startedAt,
          timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
        });
        throw new ForemanError("github_request_timeout", `GitHub GraphQL request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS}ms`, 504);
      }
      throw error;
    }

    const rateLimitHeaders = rateLimitHeadersFromResponse(response);
    this.logRateLimitHeaders(requestContext, rateLimitHeaders);

    if (!response.ok) {
      const body = await response.text();
      if (isGitHubRateLimitResponse(response.status, body, rateLimitHeaders)) {
        this.throwRateLimitError({
          context: requestContext,
          status: response.status,
          body,
          headers: rateLimitHeaders,
          durationMs: Date.now() - startedAt,
        });
      }
      this.logger.error("GitHub GraphQL request failed", {
        operationName,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      throw new ForemanError("github_request_failed", `GitHub GraphQL request failed: ${response.status} ${body}`, 502);
    }

    const json = (await response.json()) as GitHubGraphqlResponse<T>;
    if (json.errors?.length) {
      if (areGitHubGraphqlRateLimitErrors(json.errors)) {
        this.throwRateLimitError({
          context: requestContext,
          status: response.status,
          body: json.errors.map((error) => error.message).join("; "),
          headers: rateLimitHeaders,
          durationMs: Date.now() - startedAt,
        });
      }
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
    const trimmedBody = body.trimStart();
    if (trimmedBody.startsWith("<!-- linear-linkback -->")) {
      return true;
    }

    if (body.startsWith(agentPrefix)) {
      return true;
    }

    const reviewReplyPrefix = /^In reply to review [^:]+:\n\n/;
    const nestedAgentBody = body.replace(reviewReplyPrefix, "");
    return nestedAgentBody.startsWith(agentPrefix);
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

  private pullRequestUrl(task: Task, repo?: RepoRef, target?: TaskTargetRef): string | null {
    const repoKey = target?.repoKey ?? repo?.key;
    return resolveTaskPullRequest(task, repoKey)?.url ?? null;
  }

  private async resolvePullRequestFromUrl(prUrl: string, taskId: string): Promise<ResolvedPullRequest | null> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.debug("resolving GitHub pull request from task pull request", { taskId, owner, repo, pullRequestNumber: number });
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
      this.logger.debug("GitHub pull request referenced by task pull request was not found", { taskId, owner, repo, pullRequestNumber: number });
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

  private async resolvePullRequestByBranch(task: Task, repo: RepoRef, target?: TaskTargetRef): Promise<ResolvedPullRequest | null> {
    const effectiveTarget = target ?? resolveTaskTargetRef(task, repo.key);
    if (!effectiveTarget) {
      this.logger.debug("skipping branch-based GitHub pull request lookup because task has no target for repo", {
        taskId: task.id,
        repoKey: repo.key,
      });
      return null;
    }
    const branchName = resolveTaskBranchName(task, effectiveTarget);

    const descriptor = await this.repoDescriptorFromRepo(repo);
    const query = new URLSearchParams({
      state: "all",
      head: `${descriptor.owner}:${branchName}`,
      per_page: "20",
    });
    this.logger.debug("resolving GitHub pull request by task branch", {
      taskId: task.id,
      repoKey: repo.key,
      owner: descriptor.owner,
      repo: descriptor.repo,
      branchName,
    });
    const pullRequests = await this.rest<GitHubRestPullRequest[]>(`/repos/${descriptor.owner}/${descriptor.repo}/pulls?${query.toString()}`);
    const bestMatch = pullRequests
      .filter((pullRequest) => pullRequest.head.ref === branchName)
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
        branchName,
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

  async resolvePullRequest(task: Task, repo?: RepoRef, target?: TaskTargetRef): Promise<ResolvedPullRequest | null> {
    if (repo) {
      const branchPullRequest = await this.resolvePullRequestByBranch(task, repo, target);
      if (branchPullRequest) {
        return branchPullRequest;
      }
    }

    const prUrl = this.pullRequestUrl(task, repo, target);
    if (prUrl) {
      return this.resolvePullRequestFromUrl(prUrl, task.id);
    }

    if (!repo) {
      this.logger.debug("skipping GitHub pull request resolution because task has no linked pull request and no repo context", {
        taskId: task.id,
      });
    }

    return null;
  }

  async getContext(task: Task, agentPrefix: string, repo?: RepoRef, target?: TaskTargetRef): Promise<ReviewContext | null> {
    const resolvedPullRequest = await this.resolvePullRequest(task, repo, target);
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

  async findLatestOpenPullRequestBranch(task: Task, repo?: RepoRef, target?: TaskTargetRef): Promise<string | null> {
    const pullRequest = await this.resolvePullRequest(task, repo, target);
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

  private async findPendingPullRequestReview(owner: string, repo: string, number: number): Promise<GitHubRestPullRequestReview | null> {
    for (let page = 1; ; page += 1) {
      const reviews = await this.rest<GitHubRestPullRequestReview[]>(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`);
      const pendingReview = reviews.find((review) => review.state === "PENDING");
      if (pendingReview) {
        return pendingReview;
      }

      if (reviews.length < 100) {
        return null;
      }
    }
  }

  private async createPullRequestReviewWithPendingRecovery(input: {
    owner: string;
    repo: string;
    number: number;
    body: Record<string, unknown>;
    commentCount: number;
  }): Promise<void> {
    const path = `/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews`;
    const init = {
      method: "POST",
      body: JSON.stringify(input.body),
      headers: { "content-type": "application/json" },
    };

    try {
      await this.rest(path, init);
      return;
    } catch (error) {
      if (!isExistingPendingReviewError(error)) {
        throw error;
      }

      const pendingReview = await this.findPendingPullRequestReview(input.owner, input.repo, input.number);
      if (!pendingReview) {
        throw error;
      }

      this.logger.warn("deleting stale GitHub pending pull request review before retrying submission", {
        owner: input.owner,
        repo: input.repo,
        pullRequestNumber: input.number,
        reviewId: pendingReview.id,
        commentCount: input.commentCount,
      });
      await this.rest(`/repos/${input.owner}/${input.repo}/pulls/${input.number}/reviews/${pendingReview.id}`, { method: "DELETE" });
      await this.rest(path, init);
    }
  }

  async submitPullRequestReview(
    prUrl: string,
    input: {
      body: string;
      event: "COMMENT";
      comments: PullRequestReviewInlineComment[];
    },
  ): Promise<void> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.info("submitting GitHub pull request review", {
      owner,
      repo,
      pullRequestNumber: number,
      event: input.event,
      bodyLength: input.body.length,
      commentCount: input.comments.length,
    });
    try {
      await this.createPullRequestReviewWithPendingRecovery({
        owner,
        repo,
        number,
        commentCount: input.comments.length,
        body: {
          body: input.body,
          event: input.event,
          comments: input.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: comment.side ?? "RIGHT",
            body: comment.body,
          })),
        },
      });
    } catch (error) {
      if (!isUnresolvableReviewCommentError(error) || input.comments.length === 0) {
        throw error;
      }

      this.logger.warn("retrying GitHub pull request review without inline comments after unresolvable line rejection", {
        owner,
        repo,
        pullRequestNumber: number,
        commentCount: input.comments.length,
      });
      await this.createPullRequestReviewWithPendingRecovery({
        owner,
        repo,
        number,
        commentCount: 0,
        body: {
          body: fallbackReviewBodyForUnresolvableComments(input.body, input.comments),
          event: input.event,
        },
      });
    }
    this.logger.info("submitted GitHub pull request review", { owner, repo, pullRequestNumber: number, commentCount: input.comments.length });
  }

  async replyToReviewSummary(prUrl: string, reviewId: string, body: string): Promise<void> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.info("replying to GitHub review summary", { owner, repo, reviewId, pullRequestUrl: prUrl, bodyLength: body.length });
    await this.rest(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `${body}\n\nIn reply to review ${reviewId}.` }),
      headers: { "content-type": "application/json" },
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
