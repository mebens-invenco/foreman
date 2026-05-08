/**
 * OpenCode-specific JSON output handling: token extraction and stdout
 * normalization for `opencode run --format json`. Lives next to
 * `opencode-runner.ts` so all OpenCode provider knowledge stays in one place.
 *
 * OpenCode emits one `step_finish` event per agent step. Each event's
 * `part.tokens` carries the delta for that step (`input` is NEW input only,
 * `cache.read` is the cached portion, `cache.write` is provider-side cache
 * creation, `reasoning` covers hidden reasoning tokens). Per-invocation
 * totals are obtained by summing across step_finish events.
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
import { sumTokenUsage } from "./token-usage.js";

const openCodePhase = (record: JsonRecord): string | null => {
  const metadataValues = [record.metadata, isRecord(record.part) ? record.part.metadata : undefined];

  for (const metadata of metadataValues) {
    if (!isRecord(metadata) || !isRecord(metadata.openai)) {
      continue;
    }

    const phase = metadata.openai.phase;
    if (typeof phase === "string" && phase.length > 0) {
      return phase;
    }
  }

  return null;
};

const compactJson = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const openCodeErrorSummary = (record: JsonRecord): string | null => {
  const errorRecord = record.type === "error" ? record : isRecord(record.part) && record.part.type === "error" ? record.part : null;
  if (!errorRecord) {
    return null;
  }

  const directMessage = stringField(errorRecord, ["message", "text", "content", "error"]);
  if (directMessage) {
    return directMessage;
  }

  const error = errorRecord.error;
  if (error !== undefined) {
    return compactJson(error);
  }

  return compactJson(errorRecord);
};

export const extractOpenCodeStepUsage = (stepFinishRecord: JsonRecord): TokenUsage | undefined => {
  const part = isRecord(stepFinishRecord.part) ? stepFinishRecord.part : null;
  const tokens = part && isRecord(part.tokens) ? part.tokens : null;
  if (!tokens) {
    return undefined;
  }

  const inputTokens = numberField(tokens, "input");
  const outputTokens = numberField(tokens, "output");
  const reasoningOutputTokens = numberField(tokens, "reasoning");
  const cache = isRecord(tokens.cache) ? tokens.cache : null;
  const cacheReadInputTokens = cache ? numberField(cache, "read") : undefined;
  const cacheCreationInputTokens = cache ? numberField(cache, "write") : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
};

export const normalizeOpenCodeJsonOutput = (stdout: string): NormalizedJsonOutput => {
  let values: unknown[];
  try {
    values = parseJsonValues(stdout);
  } catch (error) {
    return {
      stdout,
      warning: `Failed to parse OpenCode JSON output; using raw stdout: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const records = values.filter(isRecord);
  const nativeSessionId = records.map((record) => stringField(record, ["sessionID", "sessionId", "session_id"])).find(Boolean) ?? undefined;
  const finalAnswerText = [...records]
    .reverse()
    .map((record) =>
      openCodePhase(record) === "final_answer" ? stringField(record, ["text", "content", "result", "output"]) : null,
    )
    .find(Boolean);
  const finalText = records
    .filter((record) => record.type === "final" || record.type === "result" || record.type === "message")
    .map((record) => stringField(record, ["text", "content", "result", "output"]))
    .find(Boolean);
  const text = finalAnswerText ?? finalText ?? records.map((record) => stringField(record, ["text", "content"])).filter(Boolean).join("");
  const errorSummaries = records.map(openCodeErrorSummary).filter(Boolean);
  // OpenCode emits one `step_finish` event per agent step. Each event's
  // `part.tokens` carries the delta for that step (verified empirically against
  // a multi-step run). Sum across all step_finish events to get a per-invocation
  // total — and in turn an attempt total once the executor sums attempts.
  const tokensUsed = records.reduce<TokenUsage | undefined>((totals, record) => {
    if (record.type !== "step_finish") {
      return totals;
    }
    return sumTokenUsage(totals, extractOpenCodeStepUsage(record));
  }, undefined);

  return {
    stdout: text || stdout,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(errorSummaries.length > 0
      ? { warning: `OpenCode JSON output contained error record(s): ${errorSummaries.join("; ")}` }
      : {}),
    ...(tokensUsed ? { tokensUsed } : {}),
  };
};
