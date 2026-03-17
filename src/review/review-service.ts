import type { ConversationComment, ReviewContext, Task } from "../domain.js";

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
