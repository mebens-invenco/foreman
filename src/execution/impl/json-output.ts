import type { TokenUsage } from "../../domain/index.js";
import { sumTokenUsage } from "./token-usage.js";

type JsonRecord = Record<string, unknown>;

export type NormalizedJsonOutput = {
  stdout: string;
  nativeSessionId?: string;
  warning?: string;
  tokensUsed?: TokenUsage;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonValues = (stdout: string): unknown[] => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    return [JSON.parse(trimmed)];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
};

const stringField = (record: JsonRecord, names: string[]): string | null => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  const part = record.part;
  if (isRecord(part)) {
    for (const name of names) {
      const value = part[name];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }

  return null;
};

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

const numberField = (record: JsonRecord, name: string): number | undefined => {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const tokenUsageFromRecord = (record: JsonRecord): TokenUsage | undefined => {
  const inputTokens = numberField(record, "input_tokens") ?? 0;
  const outputTokens = numberField(record, "output_tokens") ?? 0;
  const cacheCreationInputTokens = numberField(record, "cache_creation_input_tokens");
  const cacheReadInputTokens = numberField(record, "cache_read_input_tokens");

  const hasAny =
    record.input_tokens !== undefined ||
    record.output_tokens !== undefined ||
    cacheCreationInputTokens !== undefined ||
    cacheReadInputTokens !== undefined;
  if (!hasAny) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
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
  const usage = resultRecord && isRecord(resultRecord.usage) ? tokenUsageFromRecord(resultRecord.usage) : undefined;

  return {
    stdout: normalized ?? stdout,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(usage ? { tokensUsed: usage } : {}),
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
  const tokensUsed = records.reduce<TokenUsage | undefined>((totals, record) => {
    const candidate = tokenUsageFromRecord(record);
    if (candidate) {
      return sumTokenUsage(totals, candidate);
    }
    const partUsage = isRecord(record.part) ? tokenUsageFromRecord(record.part) : undefined;
    return sumTokenUsage(totals, partUsage);
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
