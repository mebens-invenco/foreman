import { describe, expect, test } from "vitest";

import {
  actionableReviewThreadFingerprint,
  actionableReviewThreads,
  failingChecksCoveredByFingerprint,
  failingChecksFingerprint,
  type ReviewContext,
} from "../../domain/index.js";

const baseContext = (reviewThreads: ReviewContext["reviewThreads"]): ReviewContext => ({
  provider: "github",
  pullRequestUrl: "https://github.com/acme/repo/pull/1",
  pullRequestNumber: 1,
  state: "open",
  isDraft: false,
  headSha: "abc123",
  headBranch: "task-0001",
  baseBranch: "main",
  headIntroducedAt: "2026-03-14T12:00:00Z",
  mergeState: "clean",
  reviewSummaries: [],
  conversationComments: [],
  reviewThreads,
  failingChecks: [],
  pendingChecks: [],
});

describe("review thread actionability", () => {
  test("keeps unresolved threads actionable when the latest comment is from a reviewer", () => {
    const context = baseContext([
      {
        id: "thread-1",
        path: "src/example.ts",
        line: 10,
        isResolved: false,
        comments: [
          {
            id: "comment-1",
            body: "Please revisit this.",
            authorName: "reviewer",
            authoredByAgent: false,
            createdAt: "2026-03-14T12:01:00Z",
          },
        ],
      },
    ]);

    expect(actionableReviewThreads(context).map((thread) => thread.id)).toEqual(["thread-1"]);
    expect(actionableReviewThreadFingerprint(context)).toBe('[{"id":"thread-1","latestCommentId":"comment-1"}]');
  });

  test("treats unresolved threads with an agent-authored latest reply as waiting on reviewer", () => {
    const context = baseContext([
      {
        id: "thread-1",
        path: "src/example.ts",
        line: 10,
        isResolved: false,
        comments: [
          {
            id: "comment-1",
            body: "Please revisit this.",
            authorName: "reviewer",
            authoredByAgent: false,
            createdAt: "2026-03-14T12:01:00Z",
          },
          {
            id: "comment-2",
            body: "[agent] I believe the current behavior is correct because...",
            authorName: "agent",
            authoredByAgent: true,
            createdAt: "2026-03-14T12:02:00Z",
          },
        ],
      },
    ]);

    expect(actionableReviewThreads(context)).toEqual([]);
    expect(actionableReviewThreadFingerprint(context)).toBe("[]");
  });
});

describe("failing check fingerprints", () => {
  test("round-trips the checkpointed failures used for coverage", () => {
    const checkpointContext = {
      ...baseContext([]),
      failingChecks: [
        { name: "lint", state: "failure" },
        { name: "unit", state: "failure" },
      ],
    } satisfies ReviewContext;
    const fingerprint = failingChecksFingerprint(checkpointContext);

    expect(fingerprint).toBe('[{"name":"lint","state":"failure"},{"name":"unit","state":"failure"}]');
    expect(
      failingChecksCoveredByFingerprint(fingerprint, {
        ...checkpointContext,
        failingChecks: [{ name: "unit", state: "failure" }],
      }),
    ).toBe(true);
    expect(
      failingChecksCoveredByFingerprint(fingerprint, {
        ...checkpointContext,
        failingChecks: [{ name: "browser", state: "failure" }],
      }),
    ).toBe(false);
  });

  test.each`
    fingerprint
    ${'{"failing":[],"pending":[]}'}
    ${"not-json"}
  `("rejects the legacy or malformed fingerprint $fingerprint", ({ fingerprint }: { fingerprint: string }) => {
    expect(failingChecksCoveredByFingerprint(fingerprint, baseContext([]))).toBe(false);
  });
});
