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
import type { NormalizedRunnerActivity } from "../../repos/attempt-activity-repo.js";
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

/**
 * Per-line activity normalizer for Claude's `--output-format json` stream.
 *
 * Claude's `-p --output-format json` mode emits a single JSON object at the
 * end of the run carrying the final result, session id, and aggregated token
 * usage. Mid-run there are no progressive events to surface (that requires
 * `--output-format stream-json`, parked for a later ticket). This normalizer
 * is therefore mostly an end-of-run summariser — it fans the final record
 * out into the assistant_message / token_usage / error / warning activities
 * the snapshot rules expect so Claude attempts stop showing as bare
 * milestone-only state.
 *
 * Returning `null` for non-result lines is intentional: any line we don't
 * recognise yields no activity rather than a misleading `unknown` row.
 * Parse failures are non-fatal upstream.
 *
 * Parking lot — if a future ticket switches Claude to `--output-format
 * stream-json`, this normalizer must additionally recognise the progressive
 * `system`/`assistant`/`user` events. Tests in `claude-activity.test.ts`
 * document the contract any such switch must keep (final result text,
 * native session id, token totals — see {@link normalizeClaudeJsonOutput}).
 */
export const normalizeClaudeActivityLine = (
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
  const sessionId = stringField(parsed, ["session_id", "sessionId", "sessionID"]);

  // The full-result record (`--output-format json` always; also the final
  // event when `stream-json` is enabled). Recognised by an explicit
  // `type: "result"` or by the presence of a string `result` field even when
  // the type field is absent (the runner test fake omits `type`).
  const isResultRecord = type === "result" || typeof parsed.result === "string";
  if (isResultRecord) {
    const activities: NormalizedRunnerActivity[] = [];
    const resultText = stringField(parsed, ["result", "text", "output", "message"]);
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : null;
    const isError = parsed.is_error === true || (subtype !== null && subtype !== "success");
    const usage = isRecord(parsed.usage) ? extractClaudeUsage(parsed.usage) : undefined;
    const basePayload: Record<string, unknown> = { claudeType: type ?? "result" };
    if (sessionId) {
      basePayload.sessionId = sessionId;
    }
    if (subtype) {
      basePayload.subtype = subtype;
    }

    if (isError) {
      activities.push({
        kind: "error",
        message: resultText ?? `Claude returned ${subtype ?? "an error"}`,
        payload: { ...basePayload, isError: true },
      });
    } else if (resultText) {
      activities.push({
        kind: "assistant_message",
        message: resultText,
        payload: basePayload,
      });
    }

    if (usage) {
      activities.push({
        kind: "token_usage",
        message: "Claude usage reported",
        payload: { ...basePayload, tokensUsed: usage },
      });
    }

    // Surface permission denials as warnings so the snapshot's warning count
    // reflects them. Claude returns this as an array; emit one warning row
    // per entry so each shows up individually in the activity feed.
    const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials : [];
    for (const denial of denials) {
      const denialRecord = isRecord(denial) ? denial : null;
      const denialMessage = denialRecord
        ? stringField(denialRecord, ["tool_name", "tool", "name", "message"]) ?? "Claude permission denied"
        : typeof denial === "string" && denial.length > 0
          ? denial
          : "Claude permission denied";
      activities.push({
        kind: "warning",
        message: `Permission denied: ${denialMessage}`,
        payload: { ...basePayload, denial },
      });
    }

    return activities.length > 0 ? activities : null;
  }

  // The `system` init event appears at the start of a stream-json run with the
  // session id. Emit it as operation_started so the attempt has a starting
  // marker even before the final result arrives.
  if (type === "system") {
    return {
      kind: "operation_started",
      message: "Claude session initialised",
      payload: {
        claudeType: type,
        ...(typeof parsed.subtype === "string" ? { subtype: parsed.subtype } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    };
  }

  if (type === "error") {
    const errorText = stringField(parsed, ["message", "error", "detail", "text"]);
    return {
      kind: "error",
      message: errorText ?? "Claude error",
      payload: { claudeType: type, ...(sessionId ? { sessionId } : {}) },
    };
  }

  return null;
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
