import { describe, expect, test } from "vitest"

import type { TaskListItem } from "../lib/api"
import { toReviewRows } from "../lib/review-rows"

const taskWithMirroredPullRequest: TaskListItem = {
  id: "ENG-5068",
  title: "Avoid live GitHub calls in tasks API",
  state: "in_review",
  updatedAt: "2026-05-07T12:00:00Z",
  url: "https://linear.app/invenco/issue/ENG-5068/avoid-live-github-calls",
  pullRequests: [
    {
      repoKey: "foreman",
      url: "https://github.com/invenco/foreman/pull/123",
      title: "ENG-5068: Avoid live GitHub calls",
      source: "provider",
    },
  ],
  targets: [
    {
      id: "target-1",
      taskId: "ENG-5068",
      repoKey: "foreman",
      branchName: "eng-5068",
      status: "in_review",
      progressState: "in_review",
      review: {
        pullRequestUrl: "https://github.com/invenco/foreman/pull/123",
        pullRequestNumber: 123,
        state: "open",
        isDraft: false,
        baseBranch: "eng-5067",
        headBranch: "eng-5068",
      },
    },
  ],
}

describe("review rows", () => {
  test("renders PR links and labels from mirrored review data", () => {
    expect(toReviewRows([taskWithMirroredPullRequest])).toEqual([
      {
        taskId: "ENG-5068",
        taskUrl: "https://linear.app/invenco/issue/ENG-5068/avoid-live-github-calls",
        target: "foreman",
        pullRequestUrl: "https://github.com/invenco/foreman/pull/123",
        pullRequestLabel: "ENG-5068: Avoid live GitHub calls",
        modifiedAt: "2026-05-07T12:00:00Z",
      },
    ])
  })

  test("returns null taskUrl when the task has no provider URL", () => {
    expect(
      toReviewRows([{ ...taskWithMirroredPullRequest, url: null }]),
    ).toEqual([
      {
        taskId: "ENG-5068",
        taskUrl: null,
        target: "foreman",
        pullRequestUrl: "https://github.com/invenco/foreman/pull/123",
        pullRequestLabel: "ENG-5068: Avoid live GitHub calls",
        modifiedAt: "2026-05-07T12:00:00Z",
      },
    ])
  })
})
