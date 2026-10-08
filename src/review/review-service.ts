import type { RepoRef, ResolvedPullRequest, ReviewContext, RunnerProvider, Task, TaskTargetRef } from "../domain/index.js";

export type ReviewCommentAttribution = {
  label: string;
  runnerName: RunnerProvider;
  runnerModel: string;
};

export type SubmittedReview = { id: string; commitId: string };

export interface ReviewService {
  resolvePullRequest(task: Task, repo?: RepoRef, target?: TaskTargetRef): Promise<ResolvedPullRequest | null>;
  resolvePullRequestReference(prUrl: string, repo: RepoRef): Promise<ResolvedPullRequest | null>;
  getContext(task: Task, agentPrefix: string, repo?: RepoRef, target?: TaskTargetRef): Promise<ReviewContext | null>;
  getSubmittedReviews(prUrl: string, reviewIds: string[]): Promise<SubmittedReview[]>;
  findLatestOpenPullRequestBranch(task: Task, repo?: RepoRef, target?: TaskTargetRef): Promise<string | null>;
}
