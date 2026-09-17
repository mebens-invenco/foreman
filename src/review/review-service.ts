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
}
