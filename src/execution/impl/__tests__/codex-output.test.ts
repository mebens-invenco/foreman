import { describe, expect, test } from "vitest";

import { extractCodexUsage, normalizeCodexJsonOutput } from "../codex-output.js";

describe("normalizeCodexJsonOutput", () => {
  test("extracts token usage and normalizes input_tokens to subtract the cached portion", () => {
    // Empirical fixture from `codex exec --json -s read-only "Reply with 'one'."`.
    // Codex's raw `input_tokens` is TOTAL input (includes cached); the extractor
    // subtracts `cached_input_tokens` so stored `inputTokens` matches the
    // "new only" semantics used by Claude/OpenCode.
    const codexOutput = [
      JSON.stringify({ type: "thread.started", thread_id: "019e05ee-8b70-7ff1-812b-ac29b94d03ec" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "one" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 20341,
          cached_input_tokens: 3456,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
    ].join("\n");

    const normalized = normalizeCodexJsonOutput(codexOutput);
    expect(normalized.tokensUsed).toEqual({
      inputTokens: 20341 - 3456,
      outputTokens: 5,
      cacheReadInputTokens: 3456,
      reasoningOutputTokens: 0,
    });
    expect(normalized.nativeSessionId).toBe("019e05ee-8b70-7ff1-812b-ac29b94d03ec");
    expect(normalized.stdout).toBe("one");
  });
});

describe("extractCodexUsage", () => {
  test("returns undefined when no usage fields are present", () => {
    expect(extractCodexUsage({})).toBeUndefined();
  });

  test("when cached_input_tokens === input_tokens, all input is treated as cached", () => {
    // Boundary case: every input token is a cache read. New input = 0,
    // cacheRead = total. Sum still equals the provider-reported total.
    const usage = extractCodexUsage({
      input_tokens: 5_000,
      cached_input_tokens: 5_000,
      output_tokens: 10,
      reasoning_output_tokens: 0,
    });
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 10,
      cacheReadInputTokens: 5_000,
      reasoningOutputTokens: 0,
    });
  });

  test("when cached_input_tokens > input_tokens (invariant violation), cacheRead is clamped to total and new is 0", () => {
    // Provider invariant: cached_input_tokens <= input_tokens. If violated,
    // clamp so that cacheReadInputTokens + inputTokens === provider's
    // input_tokens, restoring internal consistency rather than silently
    // inflating cacheReadInputTokens past the total.
    const usage = extractCodexUsage({
      input_tokens: 1_000,
      cached_input_tokens: 2_000,
      output_tokens: 7,
    });
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 7,
      cacheReadInputTokens: 1_000,
    });
  });

  test("ignores non-integer or negative token fields", () => {
    // Defence in depth: token counts must be non-negative integers; anything
    // else gets treated as absent.
    expect(
      extractCodexUsage({
        input_tokens: -5,
        cached_input_tokens: 3.14,
        output_tokens: 10,
      }),
    ).toEqual({
      inputTokens: 0, // input_tokens was absent (rejected) -> defaults to 0
      outputTokens: 10,
    });
  });
});
