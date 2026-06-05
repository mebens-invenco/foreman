import type { Task } from "../../domain/index.js";
import type { EvalCase } from "../types.js";

/**
 * v1 synthetic cases for the learning-policy write-back. Each carries a
 * simulated completed session; the harness renders the real worker prompt and
 * grades whether the model's end-of-run learning review does the right thing.
 *
 * v1 deliberately does NOT exercise the Search/dedup step or `update`
 * mutations — those need a seeded learnings store (the store seam) and land as
 * a later fidelity upgrade. Real (non-synthetic) end-to-end cases are also a
 * later upgrade.
 */

const fileTask = (id: string, title: string, description: string, priority: Task["priority"]): Task => ({
  id,
  provider: "file",
  providerId: id,
  title,
  description,
  state: "ready",
  providerState: "ready",
  priority,
  labels: ["Agent"],
  assignee: null,
  targets: [{ repoKey: "eval-repo", branchName: id.toLowerCase(), position: 0 }],
  targetDependencies: [],
  dependencies: { taskIds: [], baseTaskId: null },
  baseBranch: null,
  pullRequests: [],
  runnerOverride: null,
  updatedAt: "2026-06-01T00:00:00Z",
  url: null,
});

export const learningPolicyCases: EvalCase[] = [
  {
    id: "reusable-insight",
    description: "a session that surfaced a non-obvious, reusable pattern should produce a well-formed learning",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-0001",
      "Add retry with backoff to the Linear bulk-sync job",
      "The nightly Linear bulk-sync intermittently fails. Make it resilient to transient API throttling.",
      "high",
    ),
    syntheticSession: [
      "Added exponential backoff to the bulk-sync client and verified it against a replayed throttle window.",
      "The root cause was non-obvious: Linear's GraphQL API returns HTTP 200 with a top-level `errors[]` entry whose code is `RATELIMITED` when the query-complexity budget is exceeded — it does NOT return a 429. The existing retry logic keyed off HTTP status, so it never fired and the job just failed.",
      "The fix keys retries off the `RATELIMITED` error code in the GraphQL body and backs off using the window in `extensions`. This applies to every Linear GraphQL caller in the codebase, not just bulk-sync.",
    ].join("\n"),
    expect: "learning",
  },
  {
    id: "routine-no-learning",
    description: "a trivial, one-off session should record no learning (empty learningMutations is the correct decision)",
    action: "execution",
    provider: "file",
    task: fileTask(
      "EVAL-0002",
      "Fix typo in the dashboard header",
      "The dashboard header reads 'Overivew'. Correct the spelling.",
      "low",
    ),
    syntheticSession: [
      "Changed the string 'Overivew' to 'Overview' in DashboardHeader.tsx. One-line copy fix, no logic change.",
      "Existing tests pass unchanged. Nothing here generalises beyond this exact string.",
    ].join("\n"),
    expect: "no_learning",
  },
];
