import type { RepoRef, ResolvedPullRequest, ReviewContext, Task, TaskTargetRef } from "../domain/index.js";

export interface ReviewService {
  resolvePullRequest(task: Task, repo?: RepoRef, target?: TaskTargetRef): Promise<ResolvedPullRequest | null>;
  getContext(task: Task, agentPrefix: string, repo?: RepoRef, target?: TaskTargetRef): Promise<ReviewContext | null>;
  findLatestOpenPullRequestBranch(task: Task, repo?: RepoRef, target?: TaskTargetRef): Promise<string | null>;
  createPullRequest(input: {
    cwd: string;
    title: string;
    body: string;
    draft: boolean;
    baseBranch: string;
    headBranch: string;
  }): Promise<{ url: string; number: number }>;
  submitPullRequestReview(
    prUrl: string,
    input: {
      body: string;
      event: "COMMENT";
      comments: Array<{
        path: string;
        line: number;
        side?: "LEFT" | "RIGHT";
        body: string;
      }>;
    },
  ): Promise<void>;
  replyToReviewSummary(prUrl: string, reviewId: string, body: string): Promise<void>;
  replyToThreadComment(prUrl: string, threadId: string, body: string): Promise<void>;
  replyToPrComment(prUrl: string, commentId: string, body: string): Promise<void>;
  resolveThreads(prUrl: string, threadIds: string[]): Promise<void>;
}
