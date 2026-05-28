import type { TaskRunnerOverride, TaskRunnerRoleOverride } from "../domain/index.js";

const RUNNER_ROLE_FIELDS = ["model", "effort", "variant"] as const;
type RunnerRoleField = (typeof RUNNER_ROLE_FIELDS)[number];

const trimOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeRoleOverride = (input: unknown): TaskRunnerRoleOverride | undefined => {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const role: TaskRunnerRoleOverride = {};
  for (const field of RUNNER_ROLE_FIELDS) {
    const value = trimOrUndefined(record[field]);
    if (value !== undefined) {
      role[field] = value;
    }
  }
  return Object.keys(role).length > 0 ? role : undefined;
};

const isRunnerRoleField = (value: string): value is RunnerRoleField =>
  (RUNNER_ROLE_FIELDS as readonly string[]).includes(value);

/**
 * Normalize a `runner` value from front matter or task metadata into a
 * `TaskRunnerOverride`. Accepts both the nested shape
 * (`runner.execution.*`, `runner.reviewer.*`) and the execution shorthand
 * (`runner.model`, `runner.effort`, `runner.variant`) which expands to an
 * `execution` override.
 */
export const normalizeTaskRunnerOverride = (input: unknown): TaskRunnerOverride | null => {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const override: TaskRunnerOverride = {};

  const execution = normalizeRoleOverride(record.execution);
  if (execution) {
    override.execution = execution;
  }
  const reviewer = normalizeRoleOverride(record.reviewer);
  if (reviewer) {
    override.reviewer = reviewer;
  }

  const shorthand: Record<string, unknown> = {};
  for (const field of RUNNER_ROLE_FIELDS) {
    if (field in record) {
      shorthand[field] = record[field];
    }
  }
  const shorthandExecution = normalizeRoleOverride(shorthand);
  if (shorthandExecution) {
    override.execution = { ...(override.execution ?? {}), ...shorthandExecution };
  }

  return Object.keys(override).length > 0 ? override : null;
};

/**
 * Parse dot-path runner metadata of the form used in Linear's `Agent:` block.
 * Keys are case-insensitive at the source; the surrounding metadata parser
 * already lowercases them, so this function matches lowercase forms:
 *   runner.execution.{model,effort,variant}
 *   runner.reviewer.{model,effort,variant}
 *   runner.{model,effort,variant} (shorthand → execution)
 *
 * `entries` is an iterable of [key, value] tuples where keys are the raw
 * already-lowercased keys from the surrounding metadata parser.
 */
export const parseDotPathRunnerOverride = (entries: Iterable<readonly [string, string]>): TaskRunnerOverride | null => {
  const accumulated: Record<string, Record<string, string>> = {};

  for (const [rawKey, rawValue] of entries) {
    if (!rawKey.startsWith("runner.")) {
      continue;
    }
    const value = rawValue.trim();
    if (!value) {
      continue;
    }
    const parts = rawKey.split(".");
    if (parts.length === 2) {
      const field = parts[1]!;
      if (!isRunnerRoleField(field)) {
        continue;
      }
      const bucket = (accumulated.execution ??= {});
      bucket[field] = value;
    } else if (parts.length === 3) {
      const role = parts[1]!;
      const field = parts[2]!;
      if ((role !== "execution" && role !== "reviewer") || !isRunnerRoleField(field)) {
        continue;
      }
      const bucket = (accumulated[role] ??= {});
      bucket[field] = value;
    }
  }

  if (Object.keys(accumulated).length === 0) {
    return null;
  }
  return normalizeTaskRunnerOverride(accumulated);
};

/**
 * Serialize a runner override back to a plain object suitable for YAML front
 * matter. Returns `null` if the override is empty.
 */
export const serializeTaskRunnerOverride = (override: TaskRunnerOverride | null | undefined): Record<string, unknown> | null => {
  if (!override) {
    return null;
  }
  const result: Record<string, unknown> = {};
  if (override.execution) {
    result.execution = { ...override.execution };
  }
  if (override.reviewer) {
    result.reviewer = { ...override.reviewer };
  }
  return Object.keys(result).length > 0 ? result : null;
};
