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

const nonNegative = (value: number): number => (value > 0 ? value : 0);

export const extractCodexUsage = (usage: JsonRecord): TokenUsage | undefined => {
  const rawInput = numberField(usage, "input_tokens");
  const cachedInput = numberField(usage, "cached_input_tokens");
  const outputTokens = numberField(usage, "output_tokens");
  const reasoningOutputTokens = numberField(usage, "reasoning_output_tokens");

  if (
    rawInput === undefined &&
    cachedInput === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  const inputTokens = rawInput !== undefined && cachedInput !== undefined ? nonNegative(rawInput - cachedInput) : rawInput ?? 0;

  return {
    inputTokens,
    outputTokens: outputTokens ?? 0,
    ...(cachedInput !== undefined ? { cacheReadInputTokens: cachedInput } : {}),
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
