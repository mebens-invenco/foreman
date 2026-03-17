import type { ConversationComment, RepoRef, ResolvedPullRequest, ReviewContext, Task } from "../domain/index.js";

export interface ReviewService {
  resolvePullRequest(task: Task, repo?: RepoRef): Promise<ResolvedPullRequest | null>;
  getContext(task: Task, agentPrefix: string, repo?: RepoRef): Promise<ReviewContext | null>;
  findLatestOpenPullRequestBranch(task: Task, repo?: RepoRef): Promise<string | null>;
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
  replyToThreadComment(prUrl: string, threadId: string, body: string): Promise<void>;
  replyToPrComment(prUrl: string, commentId: string, body: string): Promise<void>;
  resolveThreads(prUrl: string, threadIds: string[]): Promise<void>;
}
