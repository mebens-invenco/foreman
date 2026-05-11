/**
 * Claude-specific JSON output handling: token extraction and stdout
 * normalization for `claude -p --output-format json`. Lives next to
 * `claude-runner.ts` so all Claude provider knowledge stays in one place.
 *
 * Claude's `result.usage` already matches `TokenUsage` after camel-casing —
 * `input_tokens` is NEW input only, with `cache_creation_input_tokens` and
 * `cache_read_input_tokens` reported separately — so no semantic
 * normalization is required, only field renaming.
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

export const extractClaudeUsage = (usage: JsonRecord): TokenUsage | undefined => {
  const inputTokens = numberField(usage, "input_tokens");
  const outputTokens = numberField(usage, "output_tokens");
  const cacheCreationInputTokens = numberField(usage, "cache_creation_input_tokens");
  const cacheReadInputTokens = numberField(usage, "cache_read_input_tokens");

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cacheReadInputTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
  };
};

export const normalizeClaudeJsonOutput = (stdout: string): NormalizedJsonOutput => {
  let values: unknown[];
  try {
    values = parseJsonValues(stdout);
  } catch (error) {
    return {
      stdout,
      warning: `Failed to parse Claude JSON output; using raw stdout: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const records = values.filter(isRecord);
  const resultRecord = records.find((record) => record.type === "result") ?? records.find((record) => typeof record.result === "string");
  const normalized = resultRecord ? stringField(resultRecord, ["result", "text", "output", "message"]) : null;
  const nativeSessionId = records.map((record) => stringField(record, ["session_id", "sessionId", "sessionID"])).find(Boolean) ?? undefined;
  const usage = resultRecord && isRecord(resultRecord.usage) ? extractClaudeUsage(resultRecord.usage) : undefined;

  return {
    stdout: normalized ?? stdout,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(usage ? { tokensUsed: usage } : {}),
  };
};
