import { describe, expect, it } from "vitest";

import type { WorkerResult } from "../../domain/index.js";
import type { ArtifactRecord } from "../../repos/artifact-repo.js";
import type { AttemptRecord } from "../../repos/attempt-repo.js";
import { harvestTraces } from "../harvest.js";

// harvestTraces reads from the workspace DB (attempts + artifacts) and the
// artifact files on disk. These tests drive it with in-memory repos and an
// injected readFile, so they assert the join/filter/parse logic without a DB.

const attempt = (id: string, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  id,
  jobId: "job-1",
  jobKind: "task",
  taskId: "ENG-1",
  target: null,
  cronJobId: null,
  stage: null,
  workerId: "w1",
  attemptNumber: 1,
  runnerName: "claude",
  runnerModel: "claude-sonnet-4-6",
  runnerVariant: "",
  runnerSessionId: null,
  nativeSessionId: null,
  status: "completed",
  startedAt: "2026-06-01T00:00:00Z",
  finishedAt: "2026-06-01T00:01:00Z",
  exitCode: 0,
  signal: null,
  summary: "did the thing",
  errorMessage: null,
  tokensUsed: null,
  ...over,
});

const artifact = (ownerId: string, type: ArtifactRecord["artifactType"], relativePath: string): ArtifactRecord => ({
  id: `${ownerId}-${type}`,
  ownerType: "execution_attempt",
  ownerId,
  artifactType: type,
  relativePath,
  mediaType: type === "parsed_result" ? "application/json" : "text/plain",
  sizeBytes: 1,
  sha256: null,
  createdAt: "2026-06-01T00:00:00Z",
});

const result = (action: WorkerResult["action"], outcome: WorkerResult["outcome"] = "completed"): WorkerResult => ({
  schemaVersion: 1,
  action,
  outcome,
  summary: `${action} summary`,
  taskMutations: [],
  reviewMutations: [],
  learningMutations: [],
  blockers: [],
  signals: [],
});

const depsFor = (
  attempts: AttemptRecord[],
  artifactsByAttempt: Record<string, ArtifactRecord[]>,
  files: Record<string, string>,
) => ({
  attempts: { listAttempts: () => attempts },
  artifacts: { listArtifacts: (_ownerType?: string, ownerId?: string) => artifactsByAttempt[ownerId ?? ""] ?? [] },
  workspaceRoot: "/ws",
  readFile: (absolutePath: string) => {
    const content = files[absolutePath];
    if (content === undefined) {
      return Promise.reject(new Error(`no such file: ${absolutePath}`));
    }
    return Promise.resolve(content);
  },
});

describe("harvestTraces", () => {
  it("joins rendered_prompt + parsed_result into a typed pair", async () => {
    const deps = depsFor(
      [attempt("a1")],
      {
        a1: [
          artifact("a1", "rendered_prompt", "artifacts/a1-prompt.md"),
          artifact("a1", "parsed_result", "artifacts/a1-result.json"),
        ],
      },
      {
        "/ws/artifacts/a1-prompt.md": "the rendered prompt",
        "/ws/artifacts/a1-result.json": JSON.stringify(result("execution")),
      },
    );

    const { traces, summary } = await harvestTraces(deps);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      attemptId: "a1",
      action: "execution",
      outcome: "completed",
      prompt: "the rendered prompt",
      runner: { name: "claude", model: "claude-sonnet-4-6" },
    });
    expect(traces[0]!.result.summary).toBe("execution summary");
    expect(summary).toMatchObject({ scannedAttempts: 1, harvested: 1, skippedNoArtifacts: 0, skippedUnparseable: 0, filteredOutByAction: 0 });
  });

  it("skips attempts missing either artifact and counts them", async () => {
    const deps = depsFor(
      [attempt("a1"), attempt("a2")],
      {
        // a1 has only the prompt (e.g. failed before producing a parseable result)
        a1: [artifact("a1", "rendered_prompt", "artifacts/a1-prompt.md")],
        a2: [],
      },
      { "/ws/artifacts/a1-prompt.md": "prompt only" },
    );

    const { traces, summary } = await harvestTraces(deps);

    expect(traces).toHaveLength(0);
    expect(summary.skippedNoArtifacts).toBe(2);
    expect(summary.harvested).toBe(0);
  });

  it("counts a parsed_result that does not validate as skippedUnparseable", async () => {
    const deps = depsFor(
      [attempt("a1")],
      {
        a1: [
          artifact("a1", "rendered_prompt", "artifacts/a1-prompt.md"),
          artifact("a1", "parsed_result", "artifacts/a1-result.json"),
        ],
      },
      {
        "/ws/artifacts/a1-prompt.md": "prompt",
        "/ws/artifacts/a1-result.json": "{ not valid worker result }",
      },
    );

    const { traces, summary } = await harvestTraces(deps);

    expect(traces).toHaveLength(0);
    expect(summary.skippedUnparseable).toBe(1);
  });

  it("filters to the requested actions and counts the rest", async () => {
    const deps = depsFor(
      [attempt("a1"), attempt("a2")],
      {
        a1: [
          artifact("a1", "rendered_prompt", "artifacts/a1-prompt.md"),
          artifact("a1", "parsed_result", "artifacts/a1-result.json"),
        ],
        a2: [
          artifact("a2", "rendered_prompt", "artifacts/a2-prompt.md"),
          artifact("a2", "parsed_result", "artifacts/a2-result.json"),
        ],
      },
      {
        "/ws/artifacts/a1-prompt.md": "review prompt",
        // reviewer + completed + no mutations is schema-invalid, so a no-op
        // reviewer result must use no_action_needed.
        "/ws/artifacts/a1-result.json": JSON.stringify(result("reviewer", "no_action_needed")),
        "/ws/artifacts/a2-prompt.md": "exec prompt",
        "/ws/artifacts/a2-result.json": JSON.stringify(result("execution")),
      },
    );

    const { traces, summary } = await harvestTraces({ ...deps, actions: new Set(["reviewer"]) });

    expect(traces).toHaveLength(1);
    expect(traces[0]!.action).toBe("reviewer");
    expect(summary).toMatchObject({ harvested: 1, filteredOutByAction: 1 });
  });

  it("does not read the prompt file for an attempt filtered out by action", async () => {
    // The prompt file is intentionally absent: if harvest tried to read it for the
    // filtered-out attempt, the injected readFile would reject and fail the run.
    const deps = depsFor(
      [attempt("a1")],
      {
        a1: [
          artifact("a1", "rendered_prompt", "artifacts/a1-prompt.md"),
          artifact("a1", "parsed_result", "artifacts/a1-result.json"),
        ],
      },
      { "/ws/artifacts/a1-result.json": JSON.stringify(result("execution")) },
    );

    const { traces, summary } = await harvestTraces({ ...deps, actions: new Set(["reviewer"]) });

    expect(traces).toHaveLength(0);
    expect(summary.filteredOutByAction).toBe(1);
  });
});
