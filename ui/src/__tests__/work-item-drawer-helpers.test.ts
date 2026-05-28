import { describe, expect, test } from "vitest"

import type { AttemptRecord, WorkItemBucket } from "../lib/api"
import {
  attemptsPagePath,
  bucketTokensTotal,
  sortAttemptsNewestFirst,
} from "../pages/work-items/work-item-drawer-helpers"

function makeBucket(
  tokens: Partial<WorkItemBucket["tokens"]> = {}
): WorkItemBucket {
  return {
    taskId: "ENG-5260",
    taskUrl: null,
    targets: ["foreman"],
    perTargetLatestStatus: [],
    effectiveStatus: "completed",
    attemptsCount: 1,
    firstSeenInWindow: "2026-05-28T08:00:00Z",
    lastStartedAt: "2026-05-28T08:00:00Z",
    lastFinishedAt: "2026-05-28T08:10:00Z",
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
      ...tokens,
    },
    cost: {
      totalUsd: 0,
      breakdown: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreate: 0,
        reasoning: 0,
      },
    },
  }
}

function makeAttempt(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    id: "attempt-1",
    jobId: "job-1",
    jobKind: "task",
    taskId: "ENG-5260",
    taskUrl: null,
    target: "foreman",
    cronJobId: null,
    stage: "execution",
    workerId: null,
    attemptNumber: 1,
    runnerName: "claude",
    runnerModel: "claude-sonnet-4-6",
    runnerVariant: "default",
    nativeSessionId: null,
    worktreePath: null,
    status: "completed",
    startedAt: "2026-05-28T10:00:00Z",
    finishedAt: "2026-05-28T10:10:00Z",
    exitCode: 0,
    signal: null,
    summary: "",
    errorMessage: null,
    tokensUsed: null,
    ...overrides,
  }
}

describe("sortAttemptsNewestFirst", () => {
  test("orders attempts by startedAt descending", () => {
    const earlier = makeAttempt({
      id: "earlier",
      startedAt: "2026-05-28T08:00:00Z",
    })
    const later = makeAttempt({
      id: "later",
      startedAt: "2026-05-28T12:00:00Z",
    })
    const middle = makeAttempt({
      id: "middle",
      startedAt: "2026-05-28T10:00:00Z",
    })

    const ordered = sortAttemptsNewestFirst([earlier, later, middle])

    expect(ordered.map((attempt) => attempt.id)).toEqual([
      "later",
      "middle",
      "earlier",
    ])
  })

  test("does not mutate the input array", () => {
    const a = makeAttempt({ id: "a", startedAt: "2026-05-28T08:00:00Z" })
    const b = makeAttempt({ id: "b", startedAt: "2026-05-28T12:00:00Z" })
    const input = [a, b]

    sortAttemptsNewestFirst(input)

    expect(input).toEqual([a, b])
  })
})

describe("bucketTokensTotal", () => {
  test("sums all five token buckets", () => {
    const bucket = makeBucket({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      reasoningOutputTokens: 50,
    })

    expect(bucketTokensTotal(bucket)).toBe(150)
  })

  test("returns 0 when all buckets are zero", () => {
    expect(bucketTokensTotal(makeBucket())).toBe(0)
  })
})

describe("attemptsPagePath", () => {
  test("builds the /attempts URL with taskId and attemptId", () => {
    expect(attemptsPagePath("ENG-5260", "01KSQ2D2Y2YKG3AFXHPWYEVXD4")).toBe(
      "/attempts?taskId=ENG-5260&attemptId=01KSQ2D2Y2YKG3AFXHPWYEVXD4"
    )
  })

  test("encodes special characters in identifiers", () => {
    expect(attemptsPagePath("ENG/5260", "attempt id")).toBe(
      "/attempts?taskId=ENG%2F5260&attemptId=attempt+id"
    )
  })
})
