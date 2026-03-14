import { exec } from "./lib/process.js";
import { ForemanError } from "./lib/errors.js";
import type { ConversationComment, ReviewContext, ReviewThread, ReviewSummary, Task } from "./domain.js";

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

export interface ReviewService {
  getContext(task: Task, agentPrefix: string): Promise<ReviewContext | null>;
  findLatestOpenPullRequestBranch(task: Task): Promise<string | null>;
  listConversationComments(prUrl: string): Promise<ConversationComment[]>;
  createPullRequest(input: {
    cwd: string;
    title: string;
    body: string;
    draft: boolean;
    baseBranch: string;
    headBranch: string;
  }): Promise<{ url: string; number: number }>;
  reopenPullRequest(input: {
    cwd: string;
    pullRequestUrl?: string;
    pullRequestNumber?: number;
    draft: boolean;
    title?: string;
    body?: string;
  }): Promise<{ url: string; number: number }>;
  replyToReviewSummary(prUrl: string, reviewId: string, body: string): Promise<void>;
  replyToPrComment(prUrl: string, commentId: string, body: string): Promise<void>;
  resolveThreads(prUrl: string, threadIds: string[]): Promise<void>;
}

export class GitHubReviewService implements ReviewService {
  private readonly token: string;

  constructor(env: Record<string, string>) {
    const token = env.GH_TOKEN;
    if (!token) {
      throw new ForemanError("missing_github_token", "GH_TOKEN is required for GitHub review operations", 400);
    }

    this.token = token;
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      throw new ForemanError("github_request_failed", `GitHub request failed: ${response.status} ${body}`, 502);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
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
      throw new ForemanError("github_request_failed", `GitHub GraphQL request failed: ${response.status} ${body}`, 502);
    }

    const json = (await response.json()) as GitHubGraphqlResponse<T>;
    if (json.errors?.length) {
      throw new ForemanError(
        "github_request_failed",
        `GitHub GraphQL request failed: ${json.errors.map((error) => error.message).join("; ")}`,
        502,
      );
    }

    if (!json.data) {
      throw new ForemanError("github_request_failed", "GitHub GraphQL response returned no data", 502);
    }

    return json.data;
  }

  private pullRequestArtifact(task: Task): string | null {
    return task.artifacts.find((artifact) => artifact.type === "pull_request")?.url ?? null;
  }

  async getContext(task: Task, agentPrefix: string): Promise<ReviewContext | null> {
    const prUrl = this.pullRequestArtifact(task);
    if (!prUrl) {
      return null;
    }

    const { owner, repo, number } = parseGitHubUrl(prUrl);
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

    const failingChecks = checks.check_runs
      .filter((check) => check.status === "completed" && check.conclusion && check.conclusion !== "success" && check.conclusion !== "neutral" && check.conclusion !== "skipped")
      .map((check) => ({ name: check.name, state: "failure" as const }));

    const pendingChecks = checks.check_runs
      .filter((check) => check.status !== "completed")
      .map((check) => ({ name: check.name, state: "pending" as const }));

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
      return null;
    }

    const context = await this.getContext(task, "");
    return context?.state === "open" ? context.headBranch : null;
  }

  async listConversationComments(prUrl: string): Promise<ConversationComment[]> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    const comments = await this.rest<Array<{ id: number; body: string; created_at: string; user: { login: string | null } | null }>>(
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    );

    return comments.map((comment) => ({
      id: String(comment.id),
      body: comment.body,
      authorName: comment.user?.login ?? null,
      createdAt: comment.created_at,
    }));
  }

  private async repoDescriptorFromCwd(cwd: string): Promise<RepoDescriptor> {
    const remote = await exec("git", ["config", "--get", "remote.origin.url"], { cwd });
    return parseGitRemote(remote.stdout);
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
      throw new ForemanError("invalid_pr_target", "Reopen pull request requires a number or URL");
    }

    const pr = await this.rest<{ html_url: string; number: number }>(`/repos/${repo.owner}/${repo.repo}/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "open", title: input.title, body: input.body }),
      headers: { "content-type": "application/json" },
    });

    if (input.draft === false) {
      return { url: pr.html_url, number: pr.number };
    }

    return { url: pr.html_url, number: pr.number };
  }

  async replyToReviewSummary(prUrl: string, reviewId: string, body: string): Promise<void> {
    const { owner, repo } = parseGitHubUrl(prUrl);
    await this.rest(`/repos/${owner}/${repo}/pulls/${reviewId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
    }).catch(async () => {
      const issue = parseGitHubUrl(prUrl);
      await this.rest(`/repos/${owner}/${repo}/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `In reply to review ${reviewId}:\n\n${body}` }),
        headers: { "content-type": "application/json" },
      });
    });
  }

  async replyToPrComment(prUrl: string, _commentId: string, body: string): Promise<void> {
    const { owner, repo, number } = parseGitHubUrl(prUrl);
    await this.rest(`/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
    });
  }

  async resolveThreads(prUrl: string, threadIds: string[]): Promise<void> {
    for (const threadId of threadIds) {
      await this.graphql(
        `mutation ResolveReviewThread($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
        }`,
        { threadId },
      );
    }
  }
}

export const resolveGitHubAuthEnv = async (env: Record<string, string>): Promise<Record<string, string>> => {
  if (env.GH_TOKEN) {
    return env;
  }

  if (env.GH_CONFIG_DIR) {
    const token = (await exec("gh", ["auth", "token"], { env })).stdout.trim();
    if (token) {
      return { ...env, GH_TOKEN: token };
    }
  }

  return env;
};
