type JsonRecord = Record<string, unknown>;

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

  return null;
};

export const normalizeClaudeJsonOutput = (stdout: string): { stdout: string; nativeSessionId?: string } => {
  let values: unknown[];
  try {
    values = parseJsonValues(stdout);
  } catch {
    return { stdout };
  }
  const records = values.filter(isRecord);
  const resultRecord = records.find((record) => typeof record.result === "string") ?? records.at(-1);
  const normalized = resultRecord ? stringField(resultRecord, ["result", "text", "output", "message"]) : null;
  const nativeSessionId = records.map((record) => stringField(record, ["session_id", "sessionId", "sessionID"])).find(Boolean) ?? undefined;

  return {
    stdout: normalized ?? stdout,
    ...(nativeSessionId ? { nativeSessionId } : {}),
  };
};

export const normalizeOpenCodeJsonOutput = (stdout: string): { stdout: string; nativeSessionId?: string } => {
  let values: unknown[];
  try {
    values = parseJsonValues(stdout);
  } catch {
    return { stdout };
  }
  const records = values.filter(isRecord);
  const nativeSessionId = records.map((record) => stringField(record, ["sessionID", "sessionId", "session_id"])).find(Boolean) ?? undefined;
  const finalText = records
    .filter((record) => record.type === "final" || record.type === "result" || record.type === "message")
    .map((record) => stringField(record, ["text", "content", "result", "output"]))
    .find(Boolean);
  const text = finalText ?? records.map((record) => stringField(record, ["text", "content"])).filter(Boolean).join("");

  return {
    stdout: text || stdout,
    ...(nativeSessionId ? { nativeSessionId } : {}),
  };
};
