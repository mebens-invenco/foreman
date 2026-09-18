/**
 * Hardcoded per-runner USD cost table for the {@link estimateCost} helper.
 *
 * Last verified against vendor pricing and runner catalogs on 2026-09-08:
 * - https://developers.openai.com/api/docs/pricing
 * - https://models.dev/api.json (`opencode models openai --verbose --refresh`)
 * - https://www.anthropic.com/pricing#api
 * - https://platform.claude.com/docs/en/about-claude/models/overview
 *
 * OpenAI entries use short-context API pricing because persisted aggregate
 * usage cannot identify which individual requests crossed the long-context
 * threshold. OpenCode `-fast` models map to OpenAI's Fast service tier.
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
  /** Cost of one million cache-write input tokens (Anthropic: 5-minute TTL). */
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
    runnerModel: "claude-fable-5",
    inputPerMtok: 10,
    outputPerMtok: 50,
    cacheReadPerMtok: 1,
    cacheWriteFiveMinPerMtok: 12.5,
  },
  {
    runnerName: "claude",
    runnerModel: "claude-fable-5-1",
    inputPerMtok: 10,
    outputPerMtok: 50,
    cacheReadPerMtok: 0.25,
    cacheWriteFiveMinPerMtok: 12.5,
  },
  {
    runnerName: "claude",
    runnerModel: "claude-opus-5",
    inputPerMtok: 5,
    outputPerMtok: 25,
    cacheReadPerMtok: 0.5,
    cacheWriteFiveMinPerMtok: 6.25,
  },
  {
    runnerName: "claude",
    runnerModel: "claude-opus-4-8",
    inputPerMtok: 5,
    outputPerMtok: 25,
    cacheReadPerMtok: 0.5,
    cacheWriteFiveMinPerMtok: 6.25,
  },
  {
    runnerName: "claude",
    runnerModel: "claude-opus-4-7",
    inputPerMtok: 5,
    outputPerMtok: 25,
    cacheReadPerMtok: 0.5,
    cacheWriteFiveMinPerMtok: 6.25,
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
    inputPerMtok: 5,
    outputPerMtok: 30,
    cacheReadPerMtok: 0.5,
    cacheWriteFiveMinPerMtok: 0,
  },
  {
    runnerName: "codex",
    runnerModel: "gpt-5.6-sol",
    inputPerMtok: 4,
    outputPerMtok: 20,
    cacheReadPerMtok: 0.4,
    cacheWriteFiveMinPerMtok: 5,
  },
  {
    runnerName: "codex",
    runnerModel: "gpt-5.6-terra",
    inputPerMtok: 2,
    outputPerMtok: 12,
    cacheReadPerMtok: 0.2,
    cacheWriteFiveMinPerMtok: 2.5,
  },
  {
    runnerName: "codex",
    runnerModel: "gpt-5.6-luna",
    inputPerMtok: 0.2,
    outputPerMtok: 1.2,
    cacheReadPerMtok: 0.02,
    cacheWriteFiveMinPerMtok: 0.25,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.5",
    inputPerMtok: 5,
    outputPerMtok: 30,
    cacheReadPerMtok: 0.5,
    cacheWriteFiveMinPerMtok: 0,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.3-codex",
    inputPerMtok: 1.75,
    outputPerMtok: 14,
    cacheReadPerMtok: 0.175,
    cacheWriteFiveMinPerMtok: 0,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.4",
    inputPerMtok: 2.5,
    outputPerMtok: 15,
    cacheReadPerMtok: 0.25,
    cacheWriteFiveMinPerMtok: 0,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.6-sol",
    inputPerMtok: 4,
    outputPerMtok: 20,
    cacheReadPerMtok: 0.4,
    cacheWriteFiveMinPerMtok: 5,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-5.6-sol-fast",
    inputPerMtok: 8,
    outputPerMtok: 40,
    cacheReadPerMtok: 0.8,
    cacheWriteFiveMinPerMtok: 10,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-6-astra",
    inputPerMtok: 10,
    outputPerMtok: 50,
    cacheReadPerMtok: 1,
    cacheWriteFiveMinPerMtok: 12.5,
  },
  {
    runnerName: "opencode",
    runnerModel: "openai/gpt-6-astra-fast",
    inputPerMtok: 20,
    outputPerMtok: 100,
    cacheReadPerMtok: 2,
    cacheWriteFiveMinPerMtok: 25,
  },
];

// Intentionally unresolved historical keys from the 2026-09-08 Lynk audit:
// `claude|opus` is a moving alias whose exact historical model was not persisted;
// `claude|claude-opus-4.7` and `opencode|gpt-5.3-codex` are malformed runner IDs.

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
