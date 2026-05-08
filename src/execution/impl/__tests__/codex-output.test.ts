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
});
