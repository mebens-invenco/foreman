import type { Task, WorkerResult } from "../../domain/index.js";
import type { EvalCase } from "../types.js";
import manifest from "./foreman-bench-manifest.json" with { type: "json" };

/**
 * The live-bench expectation payload, read only by the live-PR graders in
 * `../live-pr-graders.ts`. Mirrors the driver-side manifest entries: the
 * manifest lives HERE and never in the bench repo, because the reviewer
 * explores its worktree during a pass and an in-repo manifest naming the
 * planted findings would contaminate every case.
 */
export type LiveBenchExpect = {
  /** The outcome the fixture PR warrants. */
  outcome: Extract<WorkerResult["outcome"], "no_action_needed" | "completed">;
  /** For `completed` cases: file paths at least one inline comment must pin. */
  mustFlagPaths?: string[];
  /** For `completed` cases: inline-thread budget (nit-bait discipline). */
  maxThreads?: number;
  /** For stand-down cases: summary ceiling in characters. */
  summaryMaxChars?: number;
};

type ManifestCase = {
  id: string;
  pullRequest: number;
  branch: string;
  headSha: string;
  headIntroducedAt: string;
  continuation?: boolean;
  priorCheckpoint?: Record<string, unknown>;
  expect: LiveBenchExpect;
};

const REPO = manifest.repo;
const REPO_KEY = "foreman-bench";

const benchTask = (entry: ManifestCase): Task => ({
  id: `BENCH-${entry.pullRequest}`,
  provider: "file",
  providerId: `BENCH-${entry.pullRequest}`,
  title: `Bench case ${entry.id}`,
  description: "Review the linked pull request.",
  state: "in_review",
  providerState: "in_review",
  priority: "normal",
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: REPO_KEY, branchName: entry.branch, position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [{ repoKey: REPO_KEY, url: `https://github.com/${REPO}/pull/${entry.pullRequest}`, source: "provider", title: `Bench case ${entry.id}` }],
  runnerOverride: null,
  updatedAt: "2026-07-22T08:00:00Z",
  url: null,
});

/**
 * Layer-2 reviewer cases against the frozen fixture PRs in the live bench repo
 * (see the manifest's `note` for the freeze contract). Unlike the synthetic
 * `reviewer` eval — which bypasses the discovery loop by handing the reviewer a
 * pre-baked discovery block — these run the full live path: real worktree at
 * the pinned head, real `gh` discovery, captured (never applied) mutations.
 *
 * Live runs need GitHub access (`gh` authenticated for the fixture repo) and
 * take ~5-11 min per sample: run with `--samples 1 --timeout 1500000`.
 */
export const foremanBenchCases: EvalCase<LiveBenchExpect>[] = (manifest.cases as ManifestCase[]).map((entry) => ({
  id: entry.id,
  description: `PR #${entry.pullRequest} (${entry.branch} @ ${entry.headSha.slice(0, 7)}${entry.continuation ? ", continuation" : ""}) → ${entry.expect.outcome}`,
  action: "reviewer",
  provider: "file",
  task: benchTask(entry),
  fixture: {
    type: "live-pr",
    repo: REPO,
    pullRequest: entry.pullRequest,
    branch: entry.branch,
    headSha: entry.headSha,
    headIntroducedAt: entry.headIntroducedAt,
    ...(entry.continuation ? { continuation: true } : {}),
    ...(entry.priorCheckpoint ? { priorCheckpoint: entry.priorCheckpoint } : {}),
  },
  expect: entry.expect,
}));
