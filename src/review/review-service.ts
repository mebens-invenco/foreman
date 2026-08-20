import type { RepoRef, ResolvedPullRequest, ReviewContext, RunnerProvider, Task, TaskTargetRef } from "../domain/index.js";

export type ReviewCommentAttribution = {
  label: string;
  runnerName: RunnerProvider;
  runnerModel: string;
};

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
    attribution: ReviewCommentAttribution,
  ): Promise<void>;
  replyToReviewSummary(prUrl: string, reviewId: string, body: string, attribution: ReviewCommentAttribution): Promise<void>;
  replyToThreadComment(prUrl: string, threadId: string, body: string, attribution: ReviewCommentAttribution): Promise<void>;
  replyToPrComment(prUrl: string, commentId: string, body: string, attribution: ReviewCommentAttribution): Promise<void>;
  resolveThreads(prUrl: string, threadIds: string[]): Promise<void>;
}
