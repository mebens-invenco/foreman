/**
 * Hardcoded per-runner USD cost table for the {@link estimateCost} helper.
 *
 * Last verified against vendor pricing pages on 2026-05-26. Updating is a
 * tiny PR — bump the rate, bump the comment, ship.
 *
 * Cache-write TTL assumption (Anthropic):
 * Claude Code does not expose a TTL flag and uses Anthropic's default 5-minute
 * ephemeral cache writes. The 1-hour TTL alternative requires the
 * `extended-cache-ttl-2025-04-11` beta header which is not available on
 * ChatGPT-auth / non-API-key sessions Foreman runs under. Treat
 * `cacheWriteFiveMinPerMtok` as the only cache-write rate that ever applies
 * here. If that ever changes (TTL toggles surface in the runner config),
 * extend the entry shape rather than overloading this field.
 *
 * Codex / OpenCode are billed via ChatGPT-account subscriptions today, so
 * their per-token USD numbers are best-effort approximations against the
 * underlying model's API pricing — the value is in the consistency of the
 * cost surface, not the bill. Override when these runners gain per-token
 * billing surfaces.
 *
 * Why no variant in the key:
 * Foreman persists `runnerVariant` as the configured effort/variant
 * ("high", "max", "xhigh", …). For Claude, Codex, and OpenCode today, the
 * effort knob steers behavior but not per-token billing — the rate is
 * model-level. Keying on `runnerName + runnerModel` keeps the table from
 * silently missing on every default-config attempt. If a future runner
 * gains variant-priced tiers, extend the key shape then.
 */

import type { RunnerProvider } from "../../domain/index.js";

export type RunnerRate = {
  /** Cost of one million NEW (non-cached) input tokens, USD. */
  inputPerMtok: number;
  /** Cost of one million output tokens, USD. */
  outputPerMtok: number;
  /** Cost of one million cache-read input tokens, USD. */
  cacheReadPerMtok: number;
  /** Cost of one million cache-write input tokens at the 5-minute TTL, USD. */
  cacheWriteFiveMinPerMtok: number;
};

export type RunnerRateKey = {
  runnerName: RunnerProvider;
  runnerModel: string;
};

const buildKey = (key: RunnerRateKey): string =>
  `${key.runnerName}|${key.runnerModel}`;

// Each entry keys on runnerName|runnerModel. Model strings must match what
// Foreman persists on the attempt row — see `runnerForAction(config).model`
// in `src/workspace/config.ts` for the configured defaults.
const rateEntries: ReadonlyArray<RunnerRateKey & RunnerRate> = [
  {
    runnerName: "claude",
    runnerModel: "claude-opus-4-7",
    inputPerMtok: 15,
    outputPerMtok: 75,
    cacheReadPerMtok: 1.5,
    cacheWriteFiveMinPerMtok: 18.75,
  },
  {
    runnerName: "claude",
    runnerModel: "claude-sonnet-4-6",
    inputPerMtok: 3,
    outputPerMtok: 15,
    cacheReadPerMtok: 0.3,
    cacheWriteFiveMinPerMtok: 3.75,
  },
  {
    runnerName: "claude",
    runnerModel: "claude-haiku-4-5-20251001",
    inputPerMtok: 1,
    outputPerMtok: 5,
    cacheReadPerMtok: 0.1,
    cacheWriteFiveMinPerMtok: 1.25,
  },
  {
    runnerName: "codex",
    runnerModel: "gpt-5.5",
    inputPerMtok: 1.25,
    outputPerMtok: 10,
    cacheReadPerMtok: 0.125,
    cacheWriteFiveMinPerMtok: 1.25,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.5",
    inputPerMtok: 1.25,
    outputPerMtok: 10,
    cacheReadPerMtok: 0.125,
    cacheWriteFiveMinPerMtok: 1.25,
  },
];

const rateLookup: ReadonlyMap<string, RunnerRate> = new Map(
  rateEntries.map((entry) => {
    const { runnerName, runnerModel, ...rate } = entry;
    return [buildKey({ runnerName, runnerModel }), rate];
  }),
);

export const lookupRunnerRate = (key: RunnerRateKey): RunnerRate | null =>
  rateLookup.get(buildKey(key)) ?? null;

export const listRunnerRates = (): ReadonlyArray<RunnerRateKey & RunnerRate> =>
  rateEntries;
