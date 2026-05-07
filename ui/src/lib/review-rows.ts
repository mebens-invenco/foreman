import type { TaskListItem, TaskPullRequest, TaskTargetSummary } from "./api"

export type ReviewRow = {
  taskId: string
  target: string
  pullRequestUrl: string
  pullRequestLabel: string
  modifiedAt: string
}

function findPullRequest(
  task: TaskListItem,
  target: TaskTargetSummary
): TaskPullRequest | null {
  return task.pullRequests.find((pullRequest) => pullRequest.repoKey === target.repoKey) ?? null
}

export function toReviewRows(tasks: TaskListItem[]): ReviewRow[] {
  return tasks.flatMap((task) =>
    task.targets
      .filter((target) => target.review?.state === "open")
      .map((target) => {
        const pullRequest = findPullRequest(task, target)
        const pullRequestLabel = pullRequest?.title?.trim()
          ? pullRequest.title
          : `PR #${target.review?.pullRequestNumber ?? "-"}`

        return {
          taskId: task.id,
          target: target.repoKey,
          pullRequestUrl: target.review?.pullRequestUrl ?? pullRequest?.url ?? "",
          pullRequestLabel,
          modifiedAt: task.updatedAt,
        }
      })
  )
}
