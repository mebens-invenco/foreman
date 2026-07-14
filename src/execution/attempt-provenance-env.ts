import type { LearningUsageSource } from "../repos/learning-usage-repo.js";

const ATTEMPT_ID = "FOREMAN_ATTEMPT_ID";
const TASK_ID = "FOREMAN_TASK_ID";

/**
 * The attempt a worker session is running inside, handed to the agent process so
 * the tools it invokes — `foreman learnings search` above all — can stamp their
 * telemetry with the task that caused them.
 *
 * Env, and deliberately not a CLI flag: an agent that could pass `--attempt-id`
 * could claim a different attempt than the one it runs in, and task-distinct usage
 * is only worth counting if a task cannot inflate its own.
 *
 * Writer and reader live together so the variable names cannot drift apart. A
 * rename here that missed the CLI would not fail a build — it would quietly stamp
 * NULL forever, and the missing dimension is unbackfillable.
 */
export const attemptProvenanceEnv = (source: LearningUsageSource): Record<string, string> => ({
  [ATTEMPT_ID]: source.attemptId,
  [TASK_ID]: source.taskId,
});

/**
 * The pair, or nothing. A half-stamped env (one var set, the other empty) is an
 * uncountable touch rather than a weaker one, so it reads as ad-hoc use and stamps
 * NULL — the same as a human running the CLI by hand.
 */
export const readAttemptProvenanceEnv = (env: NodeJS.ProcessEnv): LearningUsageSource | undefined => {
  const attemptId = env[ATTEMPT_ID];
  const taskId = env[TASK_ID];
  return attemptId && taskId ? { attemptId, taskId } : undefined;
};
