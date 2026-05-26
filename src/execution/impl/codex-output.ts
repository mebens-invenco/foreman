/**
 * Codex-specific JSON output handling: token extraction and stdout
 * normalization for `codex exec --json`. Lives next to `codex-runner.ts` so
 * all Codex provider knowledge stays in one place.
 *
 * Codex's `turn.completed.usage.input_tokens` is TOTAL input (it includes the
 * cached portion). To match the cross-runner semantic where `inputTokens`
 * means "new (non-cached) input only" (matching Claude/OpenCode), this
 * extractor subtracts `cached_input_tokens` and stores the cached portion
 * under `cacheReadInputTokens`. Codex also reports `reasoning_output_tokens`.
 *
 * Invariant handling: Codex *should* always report
 * `cached_input_tokens <= input_tokens`. If a row violates this (provider
 * bug, fixture error), we clamp `cacheReadInputTokens` to `input_tokens`
 * and set `inputTokens = 0`. This keeps the stored values internally
 * consistent (cacheRead + new = total reported by provider) instead of
 * leaving an inflated `cacheReadInputTokens` next to a silently-zeroed
 * `inputTokens`. Clamp also preserves a non-zero `cacheReadInputTokens`
 * for aggregation rather than dropping the row entirely.
 */
import type { TokenUsage } from "../../domain/index.js";
import type { NormalizedRunnerActivity } from "../../repos/attempt-activity-repo.js";
import {
  type JsonRecord,
  type NormalizedJsonOutput,
  isRecord,
  numberField,
  parseJsonValues,
  stringField,
} from "./json-output.js";

const nonNegativeInt = (value: number | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return Number.isInteger(value) && value >= 0 ? value : undefined;
};

export const extractCodexUsage = (usage: JsonRecord): TokenUsage | undefined => {
  const rawInput = nonNegativeInt(numberField(usage, "input_tokens"));
  const rawCached = nonNegativeInt(numberField(usage, "cached_input_tokens"));
  const outputTokens = nonNegativeInt(numberField(usage, "output_tokens"));
  const reasoningOutputTokens = nonNegativeInt(numberField(usage, "reasoning_output_tokens"));

  if (
    rawInput === undefined &&
    rawCached === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  // Clamp the cached portion to the total when both fields are present so
  // `cacheReadInputTokens + inputTokens === rawInput` always holds.
  let inputTokens: number;
  let cacheReadInputTokens: number | undefined;
  if (rawInput !== undefined && rawCached !== undefined) {
    cacheReadInputTokens = Math.min(rawCached, rawInput);
    inputTokens = rawInput - cacheReadInputTokens;
  } else {
    cacheReadInputTokens = rawCached;
    inputTokens = rawInput ?? 0;
  }

  return {
    inputTokens,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
};

/**
 * Per-line activity normalizer for Codex's `--json` stream.
 *
 * Codex emits one JSON value per line on stdout. We translate each line into a
 * Foreman-shape {@link NormalizedRunnerActivity} so the live activity feed
 * has a uniform vocabulary across runners. Lines that don't map (parse
 * failure, unrecognised type, missing item.type) yield `null`/`undefined` or
 * a single `unknown` record — the runner's `onActivity` drain treats parse
 * failures as non-fatal.
 *
 * The shape we emit is intentionally coarse — `kind` + `message` + payload
 * with the original line context — so downstream snapshot rules can pattern-
 * match without needing to know every Codex item variant.
 */
export const normalizeCodexActivityLine = (
  line: string,
): NormalizedRunnerActivity | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (!type) {
    return null;
  }

  if (type === "thread.started") {
    const threadId = stringField(parsed, ["thread_id", "threadId", "session_id", "sessionId"]);
    return {
      kind: "operation_started",
      message: "Codex thread started",
      payload: { codexType: type, ...(threadId ? { threadId } : {}) },
    };
  }

  if (type === "turn.started") {
    return { kind: "operation_started", message: "Codex turn started", payload: { codexType: type } };
  }

  if (type === "turn.completed") {
    const usage = isRecord(parsed.usage) ? extractCodexUsage(parsed.usage) : undefined;
    return {
      kind: "token_usage",
      message: "Codex turn completed",
      payload: { codexType: type, ...(usage ? { tokensUsed: usage } : {}) },
    };
  }

  if (type === "item.started" || type === "item.completed") {
    const item = isRecord(parsed.item) ? parsed.item : null;
    const itemType = item && typeof item.type === "string" ? item.type : null;
    const text = item ? stringField(item, ["text", "content", "result", "output", "command"]) : null;
    const isCompleted = type === "item.completed";
    const basePayload: Record<string, unknown> = { codexType: type };
    if (itemType) {
      basePayload.itemType = itemType;
    }
    if (item && typeof item.id === "string") {
      basePayload.itemId = item.id;
    }

    if (itemType === "agent_message") {
      return {
        kind: "assistant_message",
        message: text ?? "Codex assistant message",
        payload: basePayload,
      };
    }

    if (itemType === "reasoning") {
      return {
        kind: "reasoning",
        message: text ?? "Codex reasoning",
        payload: basePayload,
      };
    }

    if (itemType === "command_execution" || itemType === "shell") {
      return {
        kind: isCompleted ? "command_finished" : "command_started",
        message: text ?? (isCompleted ? "Command finished" : "Command started"),
        payload: basePayload,
      };
    }

    if (itemType === "tool_call" || itemType === "tool_use") {
      return {
        kind: isCompleted ? "tool_finished" : "tool_started",
        message: text ?? (isCompleted ? "Tool finished" : "Tool started"),
        payload: basePayload,
      };
    }

    if (itemType === "file_change" || itemType === "patch") {
      return {
        kind: "diff",
        message: text ?? "File change",
        payload: basePayload,
      };
    }

    if (itemType === "error") {
      return {
        kind: "error",
        message: text ?? "Codex error",
        payload: basePayload,
      };
    }

    return {
      kind: "unknown",
      message: text ?? `Codex ${type}`,
      payload: basePayload,
    };
  }

  if (type === "error") {
    const errorText = stringField(parsed, ["message", "error", "detail"]);
    return {
      kind: "error",
      message: errorText ?? "Codex error",
      payload: { codexType: type },
    };
  }

  return {
    kind: "unknown",
    message: `Codex ${type}`,
    payload: { codexType: type },
  };
};

export const normalizeCodexJsonOutput = (stdout: string): NormalizedJsonOutput => {
  let values: unknown[];
  try {
    values = parseJsonValues(stdout);
  } catch (error) {
    return {
      stdout,
      warning: `Failed to parse Codex JSON output; using raw stdout: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const records = values.filter(isRecord);
  const nativeSessionId = records
    .map((record) => stringField(record, ["thread_id", "threadId", "session_id", "sessionId"]))
    .find(Boolean) ?? undefined;
  const turnCompleted = [...records].reverse().find((record) => record.type === "turn.completed");
  const usage = turnCompleted && isRecord(turnCompleted.usage) ? extractCodexUsage(turnCompleted.usage) : undefined;
  const agentMessageText = [...records]
    .reverse()
    .map((record) => {
      if (record.type !== "item.completed") {
        return null;
      }
      const item = isRecord(record.item) ? record.item : null;
      if (!item || item.type !== "agent_message") {
        return null;
      }
      return stringField(item, ["text", "content", "result", "output"]);
    })
    .find(Boolean);

  return {
    stdout: agentMessageText ?? stdout,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(usage ? { tokensUsed: usage } : {}),
  };
};
