import {
  actionableConversationComments,
  actionableReviewSummaries,
  actionableReviewThreads,
  type RepoRef,
  type ReviewComment,
  type ReviewContext,
  type ReviewSummary,
  type ReviewThread,
  type Task,
} from "../domain/index.js";
import {
  jsonSection,
  renderPromptTemplate,
  textSection,
  type WorkerPromptTemplateName,
} from "../prompts/template-renderer.js";
import type { WorkspaceConfig } from "../workspace/config.js";
import type { WorkspacePaths } from "../workspace/workspace-paths.js";

const yesNo = (value: boolean): string => (value ? "yes" : "no");

const renderBody = (body: string): string => ["```text", body, "```"].join("\n");

const renderReviewComment = (label: string, comment: ReviewComment): string =>
  [
    `#### ${label} \`${comment.id}\``,
    `- Author: ${comment.authorName ?? "unknown"}`,
    `- Authored by agent: ${yesNo(comment.authoredByAgent)}`,
    `- Created: ${comment.createdAt}`,
    ...(comment.url ? [`- URL: ${comment.url}`] : []),
    "",
    renderBody(comment.body),
  ].join("\n");

const renderReviewSummary = (summary: ReviewSummary): string =>
  [
    `#### Review Summary \`${summary.id}\``,
    `- Author: ${summary.authorName ?? "unknown"}`,
    `- Authored by agent: ${yesNo(summary.authoredByAgent)}`,
    `- Created: ${summary.createdAt}`,
    `- Commit: ${summary.commitId || "(none)"}`,
    `- Current head: ${yesNo(summary.isCurrentHead)}`,
    "",
    renderBody(summary.body),
  ].join("\n");

const renderReviewThread = (thread: ReviewThread): string =>
  [
    `#### Review Thread \`${thread.id}\``,
    `- Status: ${thread.isResolved ? "resolved" : "unresolved"}`,
    `- Path: ${thread.path ?? "(unknown)"}`,
    `- Line: ${thread.line ?? "(unknown)"}`,
    "",
    ...thread.comments.flatMap((comment) => [renderReviewComment("Thread Comment", comment), ""]),
  ]
    .join("\n")
    .trimEnd();

const renderCheckList = (title: string, checks: Array<{ name: string; state: "pending" | "failure" }>): string =>
  [`### ${title}`, ...(checks.length > 0 ? checks.map((check) => `- ${check.name} (${check.state})`) : ["(none)"])].join("\n");

const renderCollection = <T>(title: string, items: T[], renderItem: (item: T) => string): string =>
  [`### ${title}`, ...(items.length > 0 ? items.flatMap((item) => ["", renderItem(item)]) : ["", "(none)"])].join("\n");

const renderActionableNow = (context: ReviewContext): string => {
  const actionableThreads = actionableReviewThreads(context);
  const actionableSummaries = actionableReviewSummaries(context);
  const actionableComments = actionableConversationComments(context);

  return [
    "### Actionable Now",
    "",
    renderCollection("Unresolved Review Threads", actionableThreads, renderReviewThread),
    "",
    renderCollection("Current-Head Review Summaries", actionableSummaries, renderReviewSummary),
    "",
    renderCollection("Post-Head PR Conversation Comments", actionableComments, (comment) => renderReviewComment("PR Comment", comment)),
    "",
    renderCheckList("Failing Checks", context.failingChecks),
    "",
    renderCheckList("Pending Checks", context.pendingChecks),
    "",
    "### Merge Status",
    `- Merge state: ${context.mergeState}`,
  ].join("\n");
};

const renderHistoricalContext = (context: ReviewContext): string => {
  const actionableSummaryIds = new Set(actionableReviewSummaries(context).map((item) => item.id));
  const actionableCommentIds = new Set(actionableConversationComments(context).map((item) => item.id));
  const actionableThreadIds = new Set(actionableReviewThreads(context).map((item) => item.id));

  return [
    "### Remaining Historical Context",
    "",
    renderCollection(
      "Other Review Summaries",
      context.reviewSummaries.filter((item) => !actionableSummaryIds.has(item.id)),
      renderReviewSummary,
    ),
    "",
    renderCollection(
      "Other PR Conversation Comments",
      context.conversationComments.filter((item) => !actionableCommentIds.has(item.id)),
      (comment) => renderReviewComment("PR Comment", comment),
    ),
    "",
    renderCollection(
      "Resolved Review Threads",
      context.reviewThreads.filter((item) => !actionableThreadIds.has(item.id)),
      renderReviewThread,
    ),
  ].join("\n");
};

const renderFullReviewHistory = (context: ReviewContext): string =>
  [
    renderCollection("Review Summaries", context.reviewSummaries, renderReviewSummary),
    "",
    renderCollection("PR Conversation Comments", context.conversationComments, (comment) => renderReviewComment("PR Comment", comment)),
    "",
    renderCollection("Review Threads", context.reviewThreads, renderReviewThread),
    "",
    renderCheckList("Failing Checks", context.failingChecks),
    "",
    renderCheckList("Pending Checks", context.pendingChecks),
  ].join("\n");

const renderReviewContext = (action: WorkerPromptTemplateName, reviewContext?: ReviewContext): string => {
  if (!reviewContext) {
    return textSection("Review Context", "null");
  }

  const pullRequestDetails = [
    "### Pull Request Snapshot",
    `- Provider: ${reviewContext.provider}`,
    `- URL: ${reviewContext.pullRequestUrl}`,
    `- Number: ${reviewContext.pullRequestNumber}`,
    `- State: ${reviewContext.state}`,
    `- Draft: ${yesNo(reviewContext.isDraft)}`,
    `- Head branch: ${reviewContext.headBranch}`,
    `- Head SHA: ${reviewContext.headSha}`,
    `- Base branch: ${reviewContext.baseBranch}`,
    `- Current head introduced at: ${reviewContext.headIntroducedAt}`,
    `- Merge state: ${reviewContext.mergeState}`,
  ].join("\n");

  const history =
    action === "review" || action === "retry"
      ? [renderActionableNow(reviewContext), "", renderHistoricalContext(reviewContext)].join("\n")
      : renderFullReviewHistory(reviewContext);

  return textSection("Review Context", [pullRequestDetails, "", history].join("\n"));
};

export const renderWorkerPrompt = async (input: {
  action: WorkerPromptTemplateName;
  config: WorkspaceConfig;
  paths: WorkspacePaths;
  task: Task;
  comments: string;
  repo: RepoRef;
  worktreePath: string;
  baseBranch: string;
  reviewContext?: ReviewContext;
}): Promise<string> => {
  const repoContext = {
    repo: input.repo,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
  };

  return renderPromptTemplate({
    paths: input.paths,
    template: input.action,
    context: {
      "selected-task": jsonSection("Selected Task", input.task),
      "task-comments": textSection("Task Comments", input.comments),
      repo: jsonSection("Repository Context", repoContext),
      review: renderReviewContext(input.action, input.reviewContext),
    },
  });
};
