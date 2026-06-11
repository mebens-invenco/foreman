import { promises as fs } from "node:fs";
import path from "node:path";

import type { WorkerResult } from "../domain/index.js";
import type { WorkerResultAction } from "../execution/worker-result.js";
import { validateWorkerResult, workerResultActionValues } from "../execution/worker-result.js";
import type { ArtifactRecord, ArtifactRepo } from "../repos/artifact-repo.js";
import type { AttemptRecord, AttemptRepo } from "../repos/attempt-repo.js";

/**
 * Trace harvesting for eval corpus building.
 *
 * The error-analysis-first eval workflow needs `(rendered prompt, worker result)`
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
  /** Contents of the `rendered_prompt` artifact — what the worker actually saw. */
  prompt: string;
  /** The validated `parsed_result` artifact. */
  result: WorkerResult;
};

export type HarvestSummary = {
  scannedAttempts: number;
  harvested: number;
  /** Attempts missing a rendered_prompt or parsed_result artifact (e.g. failed before parse). */
  skippedNoArtifacts: number;
  /** parsed_result present but did not JSON-parse / validate against the schema. */
  skippedUnparseable: number;
  /** Parsed fine but the action was excluded by the `actions` filter. */
  filteredOutByAction: number;
};

export type HarvestDeps = {
  attempts: Pick<AttemptRepo, "listAttempts">;
  artifacts: Pick<ArtifactRepo, "listArtifacts">;
  /** Workspace root that artifact `relativePath`s resolve against. */
  workspaceRoot: string;
  /** Restrict to these worker actions; omit to harvest every action. */
  actions?: ReadonlySet<WorkerResultAction>;
  /** Cap on attempts scanned (most recent first via the repo's default order). */
  limit?: number;
  /** Injectable for tests; defaults to reading the file as utf8. */
  readFile?: (absolutePath: string) => Promise<string>;
};

// The worker-result schema already restricts `action` to workerResultActionValues
// (it rejects e.g. cron), but the domain `WorkerResult["action"]` type is wider,
// so narrow it explicitly for the typed `action` field and the action filter.
const isWorkerResultAction = (action: WorkerResult["action"]): action is WorkerResultAction =>
  (workerResultActionValues as readonly string[]).includes(action);

// Latest artifact of a given type for an attempt. Normally there is exactly one
// rendered_prompt / parsed_result per attempt; if a retry rewrote one, the last
// recorded wins (artifacts are listed in insertion order).
const latestArtifact = (artifacts: ArtifactRecord[], type: ArtifactRecord["artifactType"]): ArtifactRecord | undefined => {
  let found: ArtifactRecord | undefined;
  for (const artifact of artifacts) {
    if (artifact.artifactType === type) {
      found = artifact;
    }
  }
  return found;
};

export const harvestTraces = async (deps: HarvestDeps): Promise<{ traces: HarvestedTrace[]; summary: HarvestSummary }> => {
  const readFile = deps.readFile ?? ((absolutePath) => fs.readFile(absolutePath, "utf8"));
  const attempts: AttemptRecord[] = deps.attempts.listAttempts(deps.limit !== undefined ? { limit: deps.limit } : undefined);

  const traces: HarvestedTrace[] = [];
  const summary: HarvestSummary = {
    scannedAttempts: attempts.length,
    harvested: 0,
    skippedNoArtifacts: 0,
    skippedUnparseable: 0,
    filteredOutByAction: 0,
  };

  for (const attempt of attempts) {
    const artifacts = deps.artifacts.listArtifacts("execution_attempt", attempt.id);
    const promptArtifact = latestArtifact(artifacts, "rendered_prompt");
    const resultArtifact = latestArtifact(artifacts, "parsed_result");
    if (!promptArtifact || !resultArtifact) {
      summary.skippedNoArtifacts += 1;
      continue;
    }

    let result: WorkerResult;
    try {
      const rawResult = await readFile(path.join(deps.workspaceRoot, resultArtifact.relativePath));
      result = validateWorkerResult(JSON.parse(rawResult));
    } catch {
      summary.skippedUnparseable += 1;
      continue;
    }

    const action = result.action;
    if (!isWorkerResultAction(action)) {
      // Defensive: the schema rejects these, so this is unreachable in practice.
      summary.skippedUnparseable += 1;
      continue;
    }

    if (deps.actions && !deps.actions.has(action)) {
      summary.filteredOutByAction += 1;
      continue;
    }

    const prompt = await readFile(path.join(deps.workspaceRoot, promptArtifact.relativePath));
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
