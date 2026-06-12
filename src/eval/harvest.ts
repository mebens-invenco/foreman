import { promises as fs } from "node:fs";

import type { WorkerResult } from "../domain/index.js";
import type { WorkerResultAction } from "../execution/worker-result.js";
import { validateWorkerResult, workerResultActionValues } from "../execution/worker-result.js";
import { resolveArtifactContentPath } from "../lib/artifact-path.js";
import type { ArtifactRecord, ArtifactRepo } from "../repos/artifact-repo.js";
import type { AttemptRecord, AttemptRepo } from "../repos/attempt-repo.js";

/**
 * Trace harvesting for eval corpus building.
 *
 * The error-analysis-first eval workflow needs `(rendered prompt, model output)`
 * pairs from real runs. Foreman already persists both per attempt as artifacts —
 * `rendered_prompt` (the prompt the worker saw) and `parsed_result` (the validated
 * `<agent-result>` JSON) — indexed in the workspace DB under
 * `ownerType: "execution_attempt"`. This reads those back into typed pairs so a
 * new prompt's cases (and judge calibration labels) come from observed runs, not
 * imagined ones.
 *
 * The worker action is taken from the parsed result itself (the attempt row does
 * not carry it), so an attempt is only harvestable once its result parsed.
 */

export type HarvestedTrace = {
  attemptId: string;
  startedAt: string;
  runner: { name: string; model: string };
  action: WorkerResultAction;
  outcome: WorkerResult["outcome"];
  /**
   * Contents of the `rendered_prompt` artifact — what the worker actually saw.
   * Empty string in `summaryOnly` mode, where prompt files are never read.
   */
  prompt: string;
  /** The validated `parsed_result` artifact. */
  result: WorkerResult;
};

export type HarvestSkipReason =
  /** Attempt has not finished (still running) — no result to harvest yet. */
  | "not_finished"
  /** Missing a rendered_prompt or parsed_result artifact row (e.g. failed before parse). */
  | "no_artifacts"
  /** parsed_result present but did not read / JSON-parse / validate against the schema. */
  | "unparseable_result"
  /** Artifact row exists but the prompt file is missing or escapes the workspace. */
  | "missing_prompt_file";

export type HarvestSkip = {
  attemptId: string;
  reason: HarvestSkipReason;
  /** Human-readable specifics (e.g. the validation error) for diagnosing lost corpus. */
  detail?: string;
};

export type HarvestSummary = {
  scannedAttempts: number;
  harvested: number;
  /** Counts by reason; `skipped` carries the per-attempt identities. */
  skippedNotFinished: number;
  skippedNoArtifacts: number;
  skippedUnparseable: number;
  skippedMissingPromptFile: number;
  /** Parsed fine but the action was excluded by the `actions` filter. */
  filteredOutByAction: number;
  /**
   * Every skipped attempt with its reason. Skips are themselves data for a
   * corpus-mining tool — a count alone cannot tell schema drift from file rot.
   */
  skipped: HarvestSkip[];
};

export type HarvestDeps = {
  attempts: Pick<AttemptRepo, "listAttempts">;
  artifacts: Pick<ArtifactRepo, "listArtifacts">;
  /** Workspace root that artifact `relativePath`s resolve against. */
  workspaceRoot: string;
  /** Restrict to these worker actions; omit to harvest every action. */
  actions?: ReadonlySet<WorkerResultAction>;
  /** Cap on attempts scanned (most recent first — listAttempts orders started_at DESC). */
  limit?: number;
  /**
   * Only produce the summary: skip reading prompt files and accumulate no
   * traces. Results are still read — the action filter and skip accounting
   * depend on them. Caveat: prompt files are trusted, not read, so a full
   * harvest can skip (missing_prompt_file) attempts this mode counts harvested.
   */
  summaryOnly?: boolean;
  /**
   * Injectable for tests. The default resolves the relativePath inside the
   * workspace (symlink-safe, shared with the HTTP artifact endpoint) and reads
   * it as utf8.
   */
  readArtifactFile?: (workspaceRoot: string, relativePath: string) => Promise<string>;
};

// The worker-result schema already restricts `action` to workerResultActionValues
// (it rejects e.g. cron), but the domain `WorkerResult["action"]` type is wider,
// so narrow it explicitly. A miss is a Foreman bug (schema/domain divergence),
// not bad input — fail loud rather than miscounting it as an unparseable trace.
const isWorkerResultAction = (action: WorkerResult["action"]): action is WorkerResultAction =>
  (workerResultActionValues as readonly string[]).includes(action);

// First matching artifact of a given type: listArtifacts returns rows ordered
// created_at DESC (newest first), so the first match IS the latest. Normally
// there is exactly one rendered_prompt / parsed_result per attempt (createArtifact
// replaces by relative_path), so this only matters if duplicates ever appear.
const latestArtifact = (artifacts: ArtifactRecord[], type: ArtifactRecord["artifactType"]): ArtifactRecord | undefined =>
  artifacts.find((artifact) => artifact.artifactType === type);

export const harvestTraces = async (deps: HarvestDeps): Promise<{ traces: HarvestedTrace[]; summary: HarvestSummary }> => {
  const readArtifactFile =
    deps.readArtifactFile ??
    (async (workspaceRoot: string, relativePath: string) => fs.readFile(await resolveArtifactContentPath(workspaceRoot, relativePath), "utf8"));
  const readArtifact = (relativePath: string): Promise<string> => readArtifactFile(deps.workspaceRoot, relativePath);
  const attempts: AttemptRecord[] = deps.attempts.listAttempts(deps.limit !== undefined ? { limit: deps.limit } : undefined);

  const traces: HarvestedTrace[] = [];
  const summary: HarvestSummary = {
    scannedAttempts: attempts.length,
    harvested: 0,
    skippedNotFinished: 0,
    skippedNoArtifacts: 0,
    skippedUnparseable: 0,
    skippedMissingPromptFile: 0,
    filteredOutByAction: 0,
    skipped: [],
  };
  // skip() owns both halves of the accounting — the per-reason counter and the
  // identity entry — so a future reason cannot bump one without the other.
  // (filteredOutByAction is deliberately a bare counter, not a skip: filtered
  // attempts are healthy traces outside the requested slice, not lost corpus.)
  const skipCounter: Record<HarvestSkipReason, "skippedNotFinished" | "skippedNoArtifacts" | "skippedUnparseable" | "skippedMissingPromptFile"> = {
    not_finished: "skippedNotFinished",
    no_artifacts: "skippedNoArtifacts",
    unparseable_result: "skippedUnparseable",
    missing_prompt_file: "skippedMissingPromptFile",
  };
  const skip = (attemptId: string, reason: HarvestSkipReason, detail?: string): void => {
    summary[skipCounter[reason]] += 1;
    summary.skipped.push({ attemptId, reason, ...(detail !== undefined ? { detail } : {}) });
  };

  for (const attempt of attempts) {
    if (attempt.status === "running") {
      skip(attempt.id, "not_finished");
      continue;
    }

    const artifacts = deps.artifacts.listArtifacts("execution_attempt", attempt.id);
    const promptArtifact = latestArtifact(artifacts, "rendered_prompt");
    const resultArtifact = latestArtifact(artifacts, "parsed_result");
    if (!promptArtifact || !resultArtifact) {
      skip(attempt.id, "no_artifacts", `missing ${[!promptArtifact && "rendered_prompt", !resultArtifact && "parsed_result"].filter(Boolean).join(" + ")}`);
      continue;
    }

    let result: WorkerResult;
    try {
      result = validateWorkerResult(JSON.parse(await readArtifact(resultArtifact.relativePath)));
    } catch (error) {
      skip(attempt.id, "unparseable_result", error instanceof Error ? error.message : String(error));
      continue;
    }

    const action = result.action;
    if (!isWorkerResultAction(action)) {
      throw new Error(`Unreachable: parsed_result for attempt ${attempt.id} validated with non-worker action "${action}" — worker-result schema/domain divergence`);
    }

    if (deps.actions && !deps.actions.has(action)) {
      summary.filteredOutByAction += 1;
      continue;
    }

    if (deps.summaryOnly) {
      summary.harvested += 1;
      continue;
    }

    let prompt: string;
    try {
      prompt = await readArtifact(promptArtifact.relativePath);
    } catch (error) {
      skip(attempt.id, "missing_prompt_file", error instanceof Error ? error.message : String(error));
      continue;
    }

    traces.push({
      attemptId: attempt.id,
      startedAt: attempt.startedAt,
      runner: { name: attempt.runnerName, model: attempt.runnerModel },
      action,
      outcome: result.outcome,
      prompt,
      result,
    });
    summary.harvested += 1;
  }

  return { traces, summary };
};
