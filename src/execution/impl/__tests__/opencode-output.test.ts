import { describe, expect, test } from "vitest";

import { extractOpenCodeStepUsage, normalizeOpenCodeJsonOutput } from "../opencode-output.js";

describe("normalizeOpenCodeJsonOutput", () => {
  test("returns a warning and the raw stdout when JSON parsing fails", () => {
    expect(normalizeOpenCodeJsonOutput("{bad json")).toMatchObject({
      stdout: "{bad json",
      warning: expect.stringContaining("Failed to parse OpenCode JSON output"),
    });
  });

  test("extracts text and session id from a single-record output", () => {
    const opencodeOutput = JSON.stringify({
      type: "text",
      sessionID: "opencode-session",
      part: {
        type: "text",
        text: '<agent-result>{"schemaVersion":1}</agent-result>',
      },
    });
    expect(normalizeOpenCodeJsonOutput(opencodeOutput)).toMatchObject({
      stdout: '<agent-result>{"schemaVersion":1}</agent-result>',
      nativeSessionId: "opencode-session",
    });
  });

  test("prefers the final_answer phase over earlier commentary", () => {
    const opencodeFinalAnswerOutput = [
      JSON.stringify({
        type: "text",
        part: {
          type: "text",
          text: "I will validate the required `<agent-result>` payload now.",
          metadata: { openai: { phase: "commentary" } },
        },
      }),
      JSON.stringify({
        type: "text",
        part: {
          type: "text",
          text: '<agent-result>{"schemaVersion":1}</agent-result>',
          metadata: { openai: { phase: "final_answer" } },
        },
      }),
    ].join("\n");
    expect(normalizeOpenCodeJsonOutput(opencodeFinalAnswerOutput).stdout).toBe(
      '<agent-result>{"schemaVersion":1}</agent-result>',
    );
  });

  test("surfaces error records as a warning", () => {
    const opencodeProviderErrorOutput = [
      JSON.stringify({ type: "text", text: "Implemented the change." }),
      JSON.stringify({ type: "error", message: "JSON parsing failed: expected value" }),
    ].join("\n");
    expect(normalizeOpenCodeJsonOutput(opencodeProviderErrorOutput)).toMatchObject({
      stdout: "Implemented the change.",
      warning: expect.stringContaining("OpenCode JSON output contained error record(s): JSON parsing failed"),
    });
  });

  test("extracts token usage from step_finish.part.tokens", () => {
    // Empirical fixture from `opencode run --format json "Reply with 'one'."`.
    const opencodeOutput = [
      JSON.stringify({
        type: "step_start",
        sessionID: "ses_1fa1181e0ffesZ25ctVlinDFgI",
        part: { type: "step-start" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_1fa1181e0ffesZ25ctVlinDFgI",
        part: {
          type: "text",
          text: "one",
          metadata: { openai: { phase: "final_answer" } },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_1fa1181e0ffesZ25ctVlinDFgI",
        part: {
          type: "step-finish",
          reason: "stop",
          tokens: { total: 17074, input: 17052, output: 7, reasoning: 15, cache: { write: 0, read: 0 } },
          cost: 0,
        },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).tokensUsed).toEqual({
      inputTokens: 17052,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 15,
    });
  });

  test("sums token usage across multiple step_finish events", () => {
    // Empirical fixture from a multi-step opencode run with a tool call. Each
    // step_finish carries its step's delta; summing is required to get the
    // per-invocation total.
    const opencodeOutput = [
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_multi",
        part: {
          type: "step-finish",
          tokens: { total: 17144, input: 17075, output: 69, reasoning: 0, cache: { write: 0, read: 0 } },
        },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_multi",
        part: {
          type: "step-finish",
          tokens: { total: 17168, input: 264, output: 8, reasoning: 0, cache: { write: 0, read: 16896 } },
        },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).tokensUsed).toEqual({
      inputTokens: 17075 + 264,
      outputTokens: 69 + 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 16896,
      reasoningOutputTokens: 0,
    });
  });

  test("ignores events that are not step_finish when extracting tokens", () => {
    const opencodeOutput = [
      JSON.stringify({
        type: "text",
        sessionID: "ses_x",
        part: { type: "text", text: "hi", tokens: { total: 9999, input: 9999, output: 9999, cache: { read: 0, write: 0 } } },
      }),
      JSON.stringify({ type: "step_start", sessionID: "ses_x", part: { type: "step-start" } }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).tokensUsed).toBeUndefined();
  });
});

describe("extractOpenCodeStepUsage", () => {
  test("returns undefined when no usage fields are present", () => {
    expect(extractOpenCodeStepUsage({})).toBeUndefined();
    expect(extractOpenCodeStepUsage({ part: {} })).toBeUndefined();
  });
});
