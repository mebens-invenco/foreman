/**
 * Deterministic attempt status snapshot.
 *
 * Derives a single-shot view of where an attempt currently is — phase,
 * current operation, counts, progress summary, stuck state, and whether it
 * needs a human — purely from `execution_attempt`, `execution_attempt_event`,
 * `execution_attempt_activity`, `job`, and `worker` rows. No LLM, no remote
 * call.
 *
 * The shape and the rules below are the deterministic feed the observer LLM
 * (added in a later ticket) will consult; until then this snapshot is the
 * canonical source for live-status UI and CLI surfaces.
 */
import type { ForemanRepos } from "../repos/index.js";
import type { AttemptActivityKind, AttemptActivityRecord } from "../repos/attempt-activity-repo.js";
import type { AttemptRecord } from "../repos/attempt-repo.js";
import type { JobRecord } from "../repos/job-repo.js";
import type { WorkerRecord } from "../repos/worker-repo.js";

export type AttemptStatusPhase =
  | "not_started"
  | "starting"
  | "progressing"
  | "suspicious"
  | "stuck"
  | "needs_human"
  | "finished";

export type AttemptStatusSnapshot = {
  attemptId: string;
  attemptStatus: AttemptRecord["status"];
  jobStatus: JobRecord["status"] | null;
  workerStatus: WorkerRecord["status"] | null;
  phase: AttemptStatusPhase;
  currentOperation: {
    kind: AttemptActivityKind;
    message: string;
    startedAt: string;
    payload: Record<string, unknown>;
  } | null;
  counts: {
    activities: number;
    assistantMessages: number;
    commands: number;
    tools: number;
    errors: number;
    warnings: number;
    diffs: number;
  };
  progressSummary: {
    latestMeaningfulMessage: string | null;
    latestMeaningfulAt: string | null;
    latestMeaningfulKind: AttemptActivityKind | null;
  };
  stuck: {
    isStuck: boolean;
    reason: "no_activity" | "no_progress" | null;
    sinceSeconds: number | null;
  };
  needsHuman: {
    isNeeded: boolean;
    reasons: string[];
  };
  repeatedFailureCandidates: Array<{
    signature: string;
    count: number;
    latestAt: string;
  }>;
  displayWindow: AttemptActivityRecord[];
  generatedAt: string;
};

/**
 * Activity kinds that represent meaningful forward progress. Used to detect
 * non-progress periods (the agent is alive but isn't doing anything that
 * advances the task).
 */
const MEANINGFUL_PROGRESS_KINDS = new Set<AttemptActivityKind>([
  "assistant_message",
  "command_finished",
  "tool_finished",
  "diff",
  "progress",
  "foreman_milestone",
]);

const OPERATION_START_KINDS = new Set<AttemptActivityKind>([
  "operation_started",
  "command_started",
  "tool_started",
]);

const OPERATION_FINISH_KINDS = new Set<AttemptActivityKind>([
  "operation_finished",
  "command_finished",
  "tool_finished",
]);

const isFinishedStatus = (status: AttemptRecord["status"]): boolean =>
  status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "blocked";

const secondsSince = (iso: string, now: Date = new Date()): number => {
  const then = new Date(iso).getTime();
  return Math.max(0, Math.floor((now.getTime() - then) / 1000));
};

const startSignatureForFinish = (record: AttemptActivityRecord): string => {
  if (record.kind === "command_finished") return "command_started";
  if (record.kind === "tool_finished") return "tool_started";
  return "operation_started";
};

const commandSignature = (record: AttemptActivityRecord): string => {
  const itemType = typeof record.payload.itemType === "string" ? record.payload.itemType : "";
  const command = typeof record.payload.command === "string"
    ? record.payload.command
    : record.message.slice(0, 80);
  return `${itemType}:${command}`;
};

export type AttemptSnapshotOptions = {
  summaryActivityLimit?: number;
  stuckNoProgressSeconds?: number;
  stuckNoActivitySeconds?: number;
  repeatedFailureWindow?: number;
  now?: Date;
};

/**
 * Builds a snapshot for the given attempt id. Reads only repo data; never
 * hits the network and never blocks.
 */
export const buildAttemptStatusSnapshot = (
  repos: ForemanRepos,
  attemptId: string,
  options: AttemptSnapshotOptions = {},
): AttemptStatusSnapshot => {
  const now = options.now ?? new Date();
  const summaryLimit = options.summaryActivityLimit ?? 20;
  const stuckNoProgressSeconds = options.stuckNoProgressSeconds ?? 180;
  const stuckNoActivitySeconds = options.stuckNoActivitySeconds ?? 120;
  const repeatedFailureWindow = options.repeatedFailureWindow ?? 3;

  const attempt = repos.attempts.getAttempt(attemptId);
  const job = attempt.jobId ? safeGetJob(repos, attempt.jobId) : null;
  const worker = attempt.workerId ? safeGetWorker(repos, attempt.workerId) : null;

  const totalActivities = repos.attemptActivities.countActivities(attemptId);

  // Targeted query: latest display window (most recent N rows, ascending).
  const latestActivities = repos.attemptActivities.listActivities(attemptId, {});
  const displayWindow = latestActivities.slice(Math.max(0, latestActivities.length - summaryLimit));

  // Targeted query: latest activity.
  const latestActivity = displayWindow.length > 0 ? displayWindow[displayWindow.length - 1]! : null;

  // Targeted query: latest meaningful progress (across the full feed).
  const latestMeaningful = [...latestActivities]
    .reverse()
    .find((activity) => MEANINGFUL_PROGRESS_KINDS.has(activity.kind));

  // Targeted query: current operation from start/finish rows. Walk newest-
  // first; an unmatched start row is the current operation.
  const startStack: AttemptActivityRecord[] = [];
  for (const activity of latestActivities) {
    if (OPERATION_START_KINDS.has(activity.kind)) {
      startStack.push(activity);
    } else if (OPERATION_FINISH_KINDS.has(activity.kind)) {
      const expectedStart = startSignatureForFinish(activity);
      const matchIndex = [...startStack]
        .reverse()
        .findIndex((candidate) => {
          if (expectedStart === "command_started") return candidate.kind === "command_started";
          if (expectedStart === "tool_started") return candidate.kind === "tool_started";
          return candidate.kind === "operation_started";
        });
      if (matchIndex >= 0) {
        startStack.splice(startStack.length - 1 - matchIndex, 1);
      }
    }
  }
  const currentOperationActivity = startStack.length > 0 ? startStack[startStack.length - 1]! : null;

  // Targeted query: repeated command failure candidates. Walk activities
  // chronologically, counting failed `command_finished` rows by signature.
  // A `diff` row resets all in-progress counts — a normal repair loop
  // (test fails → diff → test fails → diff → test fails) is not a
  // `needsHuman` signal; only repeated identical failures with no
  // intervening file change qualify. Any signature whose post-reset run
  // crosses `repeatedFailureWindow` becomes a candidate.
  const isFailedFinish = (activity: AttemptActivityRecord): boolean => {
    if (activity.kind !== "command_finished") return false;
    const exit = activity.payload.exitCode ?? activity.payload.exit_code;
    if (typeof exit === "number" && exit !== 0) return true;
    return activity.payload.failed === true || activity.payload.success === false;
  };
  const failureGroups = new Map<string, { count: number; latestAt: string }>();
  for (const activity of latestActivities) {
    if (activity.kind === "diff") {
      failureGroups.clear();
      continue;
    }
    if (!isFailedFinish(activity)) {
      continue;
    }
    const signature = commandSignature(activity);
    const previous = failureGroups.get(signature);
    if (previous) {
      previous.count += 1;
      if (activity.createdAt > previous.latestAt) {
        previous.latestAt = activity.createdAt;
      }
    } else {
      failureGroups.set(signature, { count: 1, latestAt: activity.createdAt });
    }
  }
  const repeatedFailureCandidates = [...failureGroups.entries()]
    .filter(([, entry]) => entry.count >= repeatedFailureWindow)
    .map(([signature, entry]) => ({ signature, count: entry.count, latestAt: entry.latestAt }));

  // Counts.
  const counts = {
    activities: totalActivities,
    assistantMessages: countByKind(latestActivities, "assistant_message"),
    commands: countByKind(latestActivities, "command_finished") + countByKind(latestActivities, "command_started"),
    tools: countByKind(latestActivities, "tool_finished") + countByKind(latestActivities, "tool_started"),
    errors: countByKind(latestActivities, "error"),
    warnings: countByKind(latestActivities, "warning"),
    diffs: countByKind(latestActivities, "diff"),
  };

  // Rule: needs-human. Repeated identical command failures, explicit
  // operator-prompting milestones, or an `error` row whose payload flags it
  // as requiring intervention.
  const needsHumanReasons: string[] = [];
  if (repeatedFailureCandidates.length > 0) {
    needsHumanReasons.push("repeated_command_failure");
  }
  const milestoneNeedsHuman = latestActivities.find((activity) =>
    activity.kind === "foreman_milestone" && activity.payload.needsHuman === true,
  );
  if (milestoneNeedsHuman) {
    needsHumanReasons.push(`milestone:${String(milestoneNeedsHuman.payload.name ?? milestoneNeedsHuman.message)}`);
  }
  const errorNeedsHuman = latestActivities.find((activity) =>
    activity.kind === "error" && activity.payload.needsHuman === true,
  );
  if (errorNeedsHuman) {
    needsHumanReasons.push("error_needs_human");
  }

  // Rule: stuck / non-progress. Skip when already finished.
  let stuckIsStuck = false;
  let stuckReason: "no_activity" | "no_progress" | null = null;
  let stuckSinceSeconds: number | null = null;

  if (!isFinishedStatus(attempt.status)) {
    if (!latestActivity) {
      // Attempt is running but has produced no activity yet — only flag stuck
      // if it has been running long enough.
      const sinceStart = secondsSince(attempt.startedAt, now);
      if (sinceStart >= stuckNoActivitySeconds) {
        stuckIsStuck = true;
        stuckReason = "no_activity";
        stuckSinceSeconds = sinceStart;
      }
    } else {
      const sinceLatestActivity = secondsSince(latestActivity.createdAt, now);
      const sinceLatestMeaningful = latestMeaningful
        ? secondsSince(latestMeaningful.createdAt, now)
        : secondsSince(attempt.startedAt, now);

      if (sinceLatestActivity >= stuckNoActivitySeconds) {
        stuckIsStuck = true;
        stuckReason = "no_activity";
        stuckSinceSeconds = sinceLatestActivity;
      } else if (sinceLatestMeaningful >= stuckNoProgressSeconds) {
        stuckIsStuck = true;
        stuckReason = "no_progress";
        stuckSinceSeconds = sinceLatestMeaningful;
      }
    }
  }

  // Phase derivation. Finished status wins; otherwise pick from needs-human,
  // stuck, suspicious (repeated failures without explicit needs-human),
  // progressing, starting.
  let phase: AttemptStatusPhase;
  if (isFinishedStatus(attempt.status)) {
    phase = "finished";
  } else if (needsHumanReasons.length > 0) {
    phase = "needs_human";
  } else if (stuckIsStuck) {
    phase = "stuck";
  } else if (repeatedFailureCandidates.length > 0 || counts.errors > 0) {
    phase = "suspicious";
  } else if (latestMeaningful) {
    phase = "progressing";
  } else if (latestActivity || attempt.status === "running") {
    phase = "starting";
  } else {
    phase = "not_started";
  }

  return {
    attemptId,
    attemptStatus: attempt.status,
    jobStatus: job?.status ?? null,
    workerStatus: worker?.status ?? null,
    phase,
    currentOperation: currentOperationActivity
      ? {
          kind: currentOperationActivity.kind,
          message: currentOperationActivity.message,
          startedAt: currentOperationActivity.createdAt,
          payload: currentOperationActivity.payload,
        }
      : null,
    counts,
    progressSummary: {
      latestMeaningfulMessage: latestMeaningful?.message ?? null,
      latestMeaningfulAt: latestMeaningful?.createdAt ?? null,
      latestMeaningfulKind: latestMeaningful?.kind ?? null,
    },
    stuck: {
      isStuck: stuckIsStuck,
      reason: stuckReason,
      sinceSeconds: stuckSinceSeconds,
    },
    needsHuman: {
      isNeeded: needsHumanReasons.length > 0,
      reasons: needsHumanReasons,
    },
    repeatedFailureCandidates,
    displayWindow,
    generatedAt: now.toISOString(),
  };
};

const countByKind = (activities: AttemptActivityRecord[], kind: AttemptActivityKind): number =>
  activities.reduce((acc, activity) => (activity.kind === kind ? acc + 1 : acc), 0);

const safeGetJob = (repos: ForemanRepos, jobId: string): JobRecord | null => {
  try {
    return repos.jobs.getJob(jobId);
  } catch {
    return null;
  }
};

const safeGetWorker = (repos: ForemanRepos, workerId: string): WorkerRecord | null => {
  const worker = repos.workers.listWorkers().find((candidate) => candidate.id === workerId);
  return worker ?? null;
};
