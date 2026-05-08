/**
 * Per-runner token usage extractors plus a summing helper.
 *
 * All three CLIs (Claude, Codex, OpenCode) report token counts per API call,
 * not as cumulative session totals. Summing per-call values therefore yields a
 * clean session total — but only after each provider's raw values are
 * normalized to a consistent shape. The extractors below map provider-specific
 * field names and normalize semantics so `TokenUsage.inputTokens` always means
 * "new (non-cached) input tokens".
 *
 * Provider notes:
 * - Claude (`result.usage`): `input_tokens` is already NEW input only;
 *   `cache_creation_input_tokens` and `cache_read_input_tokens` are reported
 *   separately. Field names match `TokenUsage` after camel-casing.
 * - Codex (`turn.completed.usage`): `input_tokens` is TOTAL input (includes
 *   the cached portion). The extractor subtracts `cached_input_tokens` so the
 *   stored `inputTokens` matches Claude/OpenCode's "new only" semantics.
 *   Codex also reports `reasoning_output_tokens`.
 * - OpenCode (`step_finish.part.tokens`): `input` is NEW input only,
 *   `cache.read` is the cached portion, `cache.write` is provider-side cache
 *   creation. There may be multiple `step_finish` events per invocation —
 *   each carries its step's delta and they should be summed.
 */
import type { TokenUsage } from "../../domain/index.js";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberField = (record: JsonRecord, name: string): number | undefined => {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const nonNegative = (value: number): number => (value > 0 ? value : 0);

export const sumTokenUsage = (
  totals: TokenUsage | undefined,
  addend: TokenUsage | undefined,
): TokenUsage | undefined => {
  if (!addend) {
    return totals;
  }
  if (!totals) {
    return { ...addend };
  }

  const next: TokenUsage = {
    inputTokens: totals.inputTokens + addend.inputTokens,
    outputTokens: totals.outputTokens + addend.outputTokens,
  };

  if (totals.cacheCreationInputTokens !== undefined || addend.cacheCreationInputTokens !== undefined) {
    next.cacheCreationInputTokens =
      (totals.cacheCreationInputTokens ?? 0) + (addend.cacheCreationInputTokens ?? 0);
  }
  if (totals.cacheReadInputTokens !== undefined || addend.cacheReadInputTokens !== undefined) {
    next.cacheReadInputTokens =
      (totals.cacheReadInputTokens ?? 0) + (addend.cacheReadInputTokens ?? 0);
  }
  if (totals.reasoningOutputTokens !== undefined || addend.reasoningOutputTokens !== undefined) {
    next.reasoningOutputTokens =
      (totals.reasoningOutputTokens ?? 0) + (addend.reasoningOutputTokens ?? 0);
  }

  return next;
};

/**
 * Read Claude's per-call usage from a `result` event's `usage` object.
 * Field names already match `TokenUsage` after camel-casing; no semantic
 * normalization required.
 */
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
 * Read Codex's per-call usage from a `turn.completed` event's `usage` object.
 * Codex's raw `input_tokens` is TOTAL input (cached + non-cached). To match
 * the cross-runner semantic where `inputTokens` is NEW only, this extractor
 * subtracts `cached_input_tokens` and stores the cached portion under
 * `cacheReadInputTokens`.
 */
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

/**
 * Read OpenCode's per-step usage from a `step_finish` event's `part.tokens`
 * object. `input` is NEW input only (Claude-style), `cache.read` is the
 * cached portion, `cache.write` is provider-side cache creation, and
 * `reasoning` covers hidden reasoning tokens.
 */
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
