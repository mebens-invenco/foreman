export type ReviewProvider = "github";

export type ReviewSummary = {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  commitId: string;
};

export type ConversationComment = {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  url?: string;
};

export type ReviewThread = {
  id: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: ConversationComment[];
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
  actionableReviewSummaries: ReviewSummary[];
  actionableConversationComments: ConversationComment[];
  unresolvedThreads: ReviewThread[];
  failingChecks: CheckState[];
  pendingChecks: CheckState[];
};
