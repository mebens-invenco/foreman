/**
 * Shared types and helpers for runner output normalization.
 *
 * Per-runner JSON parsing, token extraction, and normalization live with the
 * runner (`<runner>-runner.ts` and a sibling `<runner>-output.ts`). This file
 * holds only the runner-agnostic primitives those modules build on:
 * `NormalizedJsonOutput` (the contract a runner returns to `runAgentProcess`)
 * and small JSON-walking helpers shared across runners.
 */
import type { TokenUsage } from "../../domain/index.js";

export type JsonRecord = Record<string, unknown>;

export type NormalizedJsonOutput = {
  stdout: string;
  nativeSessionId?: string;
  warning?: string;
  tokensUsed?: TokenUsage;
};

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJsonValues = (stdout: string): unknown[] => {
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

export const numberField = (record: JsonRecord, name: string): number | undefined => {
  const value = record[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const stringField = (record: JsonRecord, names: string[]): string | null => {
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
