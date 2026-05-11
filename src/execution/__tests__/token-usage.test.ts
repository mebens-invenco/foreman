import { describe, expect, test } from "vitest";

import { extractClaudeUsage } from "../impl/claude-output.js";
import { extractCodexUsage } from "../impl/codex-output.js";
import { extractOpenCodeStepUsage } from "../impl/opencode-output.js";
import { sumTokenUsage } from "../impl/token-usage.js";

describe("sumTokenUsage across runners", () => {
  test("session-level sum matches per-call deltas across all three runners", () => {
    // Property-style: simulate three back-to-back invocations on the same
    // session. Empirical numbers from spec match these fixtures.
    const claudeCalls = [
      // C1 (fresh) — only input/output relevant for the property
      { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 56881, cache_read_input_tokens: 0 },
      { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 111, cache_read_input_tokens: 56881 },
      { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 110, cache_read_input_tokens: 56992 },
    ];
    const claudeTotal = claudeCalls
      .map(extractClaudeUsage)
      .reduce<ReturnType<typeof sumTokenUsage>>((totals, current) => sumTokenUsage(totals, current), undefined);
    expect(claudeTotal).toEqual({
      inputTokens: 15,
      outputTokens: 18,
      cacheCreationInputTokens: 56881 + 111 + 110,
      cacheReadInputTokens: 0 + 56881 + 56992,
    });

    const codexCalls = [
      { input_tokens: 20344, cached_input_tokens: 3456, output_tokens: 17, reasoning_output_tokens: 10 },
      { input_tokens: 40719, cached_input_tokens: 23296, output_tokens: 22, reasoning_output_tokens: 10 },
      { input_tokens: 61113, cached_input_tokens: 43648, output_tokens: 27, reasoning_output_tokens: 10 },
    ];
    const codexTotal = codexCalls
      .map(extractCodexUsage)
      .reduce<ReturnType<typeof sumTokenUsage>>((totals, current) => sumTokenUsage(totals, current), undefined);
    // After Codex normalization, summing inputTokens is meaningful — each call
    // contributes only its NEW input, not the rehashed cached prior context.
    expect(codexTotal).toEqual({
      inputTokens: (20344 - 3456) + (40719 - 23296) + (61113 - 43648),
      outputTokens: 17 + 22 + 27,
      cacheReadInputTokens: 3456 + 23296 + 43648,
      reasoningOutputTokens: 30,
    });

    const opencodeSteps = [
      {
        type: "step_finish",
        part: { tokens: { total: 17055, input: 17050, output: 5, cache: { read: 0, write: 0 } } },
      },
      {
        type: "step_finish",
        part: { tokens: { total: 17079, input: 5298, output: 5, cache: { read: 11776, write: 0 } } },
      },
      {
        type: "step_finish",
        part: { tokens: { total: 17089, input: 5308, output: 5, cache: { read: 11776, write: 0 } } },
      },
    ];
    const opencodeTotal = opencodeSteps
      .map(extractOpenCodeStepUsage)
      .reduce<ReturnType<typeof sumTokenUsage>>((totals, current) => sumTokenUsage(totals, current), undefined);
    expect(opencodeTotal).toEqual({
      inputTokens: 17050 + 5298 + 5308,
      outputTokens: 15,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 11776 + 11776,
    });
  });
});
