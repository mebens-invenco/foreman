export type ReviewProvider = "github";

export type ReviewSummary = {
  id: string;
  body: string;
  authorName: string | null;
  authoredByAgent: boolean;
  createdAt: string;
  commitId: string;
  isCurrentHead: boolean;
};

export type ReviewComment = {
  id: string;
  body: string;
  authorName: string | null;
  authoredByAgent: boolean;
  createdAt: string;
  url?: string;
};

export type ConversationComment = ReviewComment & {
  isAfterCurrentHead: boolean;
};

export type ReviewThread = {
  id: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: ReviewComment[];
};

export type CheckState = {
  name: string;
  state: "pending" | "failure";
};

export type ResolvedPullRequest = {
  pullRequestUrl: string;
  pullRequestNumber: number;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
};

export type ReviewContext = {
  provider: ReviewProvider;
  pullRequestUrl: string;
  pullRequestNumber: number;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  headIntroducedAt: string;
  mergeState: "clean" | "conflicting" | "dirty" | "unknown";
  reviewSummaries: ReviewSummary[];
  conversationComments: ConversationComment[];
  reviewThreads: ReviewThread[];
  failingChecks: CheckState[];
  pendingChecks: CheckState[];
};

export const isActionableReviewSummary = (summary: ReviewSummary): boolean => summary.isCurrentHead && !summary.authoredByAgent;

export const isActionableConversationComment = (comment: ConversationComment): boolean => comment.isAfterCurrentHead && !comment.authoredByAgent;

export const isActionableReviewThread = (thread: ReviewThread): boolean => !thread.isResolved;

export const actionableReviewSummaries = (context: ReviewContext): ReviewSummary[] =>
  context.reviewSummaries.filter(isActionableReviewSummary);

export const actionableConversationComments = (context: ReviewContext): ConversationComment[] =>
  context.conversationComments.filter(isActionableConversationComment);

export const actionableReviewThreads = (context: ReviewContext): ReviewThread[] =>
  context.reviewThreads.filter(isActionableReviewThread);

export const latestActionableReviewSummaryId = (context: ReviewContext): string | null =>
  actionableReviewSummaries(context).at(-1)?.id ?? null;

export const latestActionableConversationCommentId = (context: ReviewContext): string | null =>
  actionableConversationComments(context).at(-1)?.id ?? null;
