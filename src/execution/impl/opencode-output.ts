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
import type { NormalizedRunnerActivity } from "../../repos/attempt-activity-repo.js";
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

const partType = (record: JsonRecord): string | null => {
  const part = isRecord(record.part) ? record.part : null;
  return part && typeof part.type === "string" ? part.type : null;
};

const partText = (record: JsonRecord): string | null => {
  const part = isRecord(record.part) ? record.part : null;
  const direct = stringField(record, ["text", "content", "result", "output"]);
  if (direct) {
    return direct;
  }
  return part ? stringField(part, ["text", "content", "result", "output"]) : null;
};

const sessionIdField = (record: JsonRecord): string | null =>
  stringField(record, ["sessionID", "sessionId", "session_id"]);

/**
 * Per-line activity normalizer for OpenCode's `run --format json` stream.
 *
 * OpenCode emits one JSON value per line covering its session lifecycle,
 * agent steps, message text, errors, and (in some configurations) tool /
 * command parts. We translate each line into a Foreman-shape
 * {@link NormalizedRunnerActivity} so the live activity feed has a uniform
 * vocabulary across runners.
 *
 * Coverage is intentionally conservative — only shapes verified by
 * captured fixtures (session, step_start, step_finish, text, message,
 * final, error) are mapped to specific kinds. Anything else with a `type`
 * (notably tool/command/patch variants whose shape varies by opencode
 * version) yields a kind: "unknown" record carrying the original type +
 * `part.type`, so the feed still surfaces the activity for inspection
 * without making up unverified semantics. Parse failures return `null`
 * (non-fatal upstream).
 */
export const normalizeOpenCodeActivityLine = (
  line: string,
): NormalizedRunnerActivity | NormalizedRunnerActivity[] | null => {
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

  const sessionId = sessionIdField(parsed);
  const phase = openCodePhase(parsed);
  const subPartType = partType(parsed);
  const basePayload: Record<string, unknown> = { opencodeType: type };
  if (subPartType) {
    basePayload.partType = subPartType;
  }
  if (phase) {
    basePayload.phase = phase;
  }
  if (sessionId) {
    basePayload.sessionId = sessionId;
  }

  if (type === "session" || type === "session_start" || type === "session_started") {
    return {
      kind: "operation_started",
      message: "OpenCode session started",
      payload: basePayload,
    };
  }

  if (type === "step_start") {
    return {
      kind: "operation_started",
      message: "OpenCode step started",
      payload: basePayload,
    };
  }

  if (type === "step_finish") {
    const usage = extractOpenCodeStepUsage(parsed);
    const activities: NormalizedRunnerActivity[] = [];
    if (usage) {
      activities.push({
        kind: "token_usage",
        message: "OpenCode step usage reported",
        payload: { ...basePayload, tokensUsed: usage },
      });
    }
    activities.push({
      kind: "operation_finished",
      message: "OpenCode step finished",
      payload: basePayload,
    });
    return activities;
  }

  if (type === "error" || subPartType === "error") {
    const errorText = openCodeErrorSummary(parsed) ?? stringField(parsed, ["message", "error", "detail", "text"]);
    return {
      kind: "error",
      message: errorText ?? "OpenCode error",
      payload: basePayload,
    };
  }

  if (type === "text" || type === "message" || type === "final") {
    const text = partText(parsed);
    if (!text) {
      return null;
    }
    // Commentary phase carries OpenCode's thinking; surface as reasoning so it
    // doesn't crowd assistant_message counts. Final-answer / unannotated text
    // is the assistant's reply.
    const kind: NormalizedRunnerActivity["kind"] = phase === "commentary" ? "reasoning" : "assistant_message";
    return {
      kind,
      message: text,
      payload: basePayload,
    };
  }

  // Tool / command / patch / other shape variants: surface as "unknown" with
  // the partType in the payload so the feed still records the activity. A
  // follow-up ticket can promote these to tool_started/command_started/etc.
  // once a real fixture for the current opencode version is captured.
  return {
    kind: "unknown",
    message: subPartType ? `OpenCode ${type}:${subPartType}` : `OpenCode ${type}`,
    payload: basePayload,
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
