import { ForemanError } from "../../lib/errors.js";
import { exec } from "../../lib/process.js";
import { LoggerService } from "../../logger.js";
import type { CheckState, ConversationComment, ReviewContext, ReviewThread, ReviewSummary, Task } from "../../domain.js";
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

  private pullRequestArtifact(task: Task): string | null {
    return task.artifacts.find((artifact) => artifact.type === "pull_request")?.url ?? null;
  }

  async getContext(task: Task, agentPrefix: string): Promise<ReviewContext | null> {
    const prUrl = this.pullRequestArtifact(task);
    if (!prUrl) {
      this.logger.debug("skipping GitHub review context lookup because task has no pull request artifact", { taskId: task.id });
      return null;
    }

    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.debug("fetching GitHub pull request context", { taskId: task.id, owner, repo, pullRequestNumber: number });
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
          commits: { nodes: Array<{ commit: { committedDate: string } }> };
          reviews: { nodes: Array<{ id: string; body: string; submittedAt: string; author: { login: string | null } | null; commit: { oid: string } | null }> };
          comments: { nodes: Array<{ id: string; body: string; createdAt: string; author: { login: string | null } | null }> };
          reviewThreads: { nodes: Array<{ id: string; isResolved: boolean; path: string | null; line: number | null }> };
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
            commits(last: 1) { nodes { commit { committedDate } } }
            reviews(last: 100) {
              nodes { id body submittedAt author { login } commit { oid } }
            }
            comments(last: 100) {
              nodes { id body createdAt author { login } }
            }
            reviewThreads(last: 100) {
              nodes { id isResolved path line }
            }
          }
        }
      }`,
      { owner, repo, number },
    );

    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      this.logger.debug("GitHub pull request context not found", { taskId: task.id, owner, repo, pullRequestNumber: number });
      return null;
    }

    const headIntroducedAt = pullRequest.commits.nodes.at(-1)?.commit.committedDate ?? new Date().toISOString();
    const actionableReviewSummaries: ReviewSummary[] = pullRequest.reviews.nodes
      .filter((review) => Boolean(review.body?.trim()))
      .filter((review) => !review.body.startsWith(agentPrefix))
      .filter((review) => review.commit?.oid === pullRequest.headRefOid)
      .map((review) => ({
        id: review.id,
        body: review.body,
        authorName: review.author?.login ?? null,
        createdAt: review.submittedAt,
        commitId: review.commit?.oid ?? "",
      }));

    const actionableConversationComments: ConversationComment[] = pullRequest.comments.nodes
      .filter((comment) => Boolean(comment.body?.trim()))
      .filter((comment) => !comment.body.startsWith(agentPrefix))
      .filter((comment) => new Date(comment.createdAt).getTime() >= new Date(headIntroducedAt).getTime())
      .map((comment) => ({
        id: comment.id,
        body: comment.body,
        authorName: comment.author?.login ?? null,
        createdAt: comment.createdAt,
      }));

    const unresolvedThreads: ReviewThread[] = pullRequest.reviewThreads.nodes
      .filter((thread) => !thread.isResolved)
      .map((thread) => ({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        isResolved: thread.isResolved,
      }));

    const checks = await this.rest<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(
      `/repos/${owner}/${repo}/commits/${pullRequest.headRefOid}/check-runs`,
    );
    const statuses = await this.rest<{ statuses: Array<{ context: string; state: string }> }>(
      `/repos/${owner}/${repo}/commits/${pullRequest.headRefOid}/status`,
    );

    const { failingChecks, pendingChecks } = mergeCheckStates({ checkRuns: checks.check_runs, statuses: statuses.statuses });

    this.logger.debug("fetched GitHub pull request context", {
      taskId: task.id,
      owner,
      repo,
      pullRequestNumber: pullRequest.number,
      state: pullRequest.merged ? "merged" : pullRequest.state === "OPEN" ? "open" : "closed",
      reviewSummaryCount: actionableReviewSummaries.length,
      conversationCommentCount: actionableConversationComments.length,
      unresolvedThreadCount: unresolvedThreads.length,
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
      mergeState: this.mapMergeState(pullRequest.mergeStateStatus),
      actionableReviewSummaries,
      actionableConversationComments,
      unresolvedThreads,
      failingChecks,
      pendingChecks,
    };
  }

  private mapMergeState(value: string): ReviewContext["mergeState"] {
    switch (value) {
      case "CLEAN":
      case "HAS_HOOKS":
      case "UNSTABLE":
        return "clean";
      case "DIRTY":
        return "dirty";
      case "CONFLICTING":
        return "conflicting";
      default:
        return "unknown";
    }
  }

  async findLatestOpenPullRequestBranch(task: Task): Promise<string | null> {
    const prUrl = this.pullRequestArtifact(task);
    if (!prUrl) {
      this.logger.debug("skipping open pull request branch lookup because task has no pull request artifact", { taskId: task.id });
      return null;
    }

    const context = await this.getContext(task, "");
    const branch = context?.state === "open" ? context.headBranch : null;
    this.logger.debug("resolved latest open pull request branch", { taskId: task.id, branch: branch ?? null });
    return branch;
  }

  async listConversationComments(prUrl: string): Promise<ConversationComment[]> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    this.logger.debug("listing GitHub pull request conversation comments", { owner, repo, pullRequestNumber: number });
    const comments = await this.rest<Array<{ id: number; body: string; created_at: string; user: { login: string | null } | null }>>(
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    );

    const mapped = comments.map((comment) => ({
      id: String(comment.id),
      body: comment.body,
      authorName: comment.user?.login ?? null,
      createdAt: comment.created_at,
    }));

    this.logger.debug("listed GitHub pull request conversation comments", { owner, repo, pullRequestNumber: number, count: mapped.length });
    return mapped;
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
