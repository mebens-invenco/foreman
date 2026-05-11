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
