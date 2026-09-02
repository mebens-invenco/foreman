import { describe, expect, test } from "vitest";

import { parseWorkerResult } from "../../worker-result.js";
import { extractOpenCodeStepUsage, normalizeOpenCodeJsonOutput, redactRetryableOpenCodeErrorLine } from "../opencode-output.js";

describe("normalizeOpenCodeJsonOutput", () => {
  test("returns a warning and the raw stdout when JSON parsing fails", () => {
    expect(normalizeOpenCodeJsonOutput("{bad json")).toMatchObject({
      stdout: "{bad json",
      warning: expect.stringContaining("Failed to parse OpenCode JSON output"),
    });
    expect(normalizeOpenCodeJsonOutput("{bad json").retryableInterruption).toBeUndefined();
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

  test("preserves a result block when compaction emits later final prose", () => {
    const workerResult = {
      schemaVersion: 1,
      action: "execution",
      outcome: "completed",
      summary: "Implemented the change.",
      taskMutations: [],
      reviewMutations: [],
      learningMutations: [],
      blockers: [],
      signals: ["code_changed"],
    };
    const resultText = `<agent-result>${JSON.stringify(workerResult)}</agent-result>`;
    const compactedOutput = [
      JSON.stringify({
        type: "text",
        part: { type: "text", text: resultText, metadata: { openai: { phase: "final_answer" } } },
      }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "compaction" } }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "Continue from the summary.", metadata: { openai: { phase: "commentary" } } },
      }),
      JSON.stringify({
        type: "text",
        part: {
          type: "text",
          text: "The requested implementation and verification are complete.",
          metadata: { openai: { phase: "final_answer" } },
        },
      }),
    ].join("\n");

    const normalized = normalizeOpenCodeJsonOutput(compactedOutput);

    expect(normalized.stdout).toBe(resultText);
    expect(parseWorkerResult(normalized.stdout)).toEqual(workerResult);
  });

  test("selects the latest final answer containing a result block", () => {
    const resultText = (summary: string) => `<agent-result>{"summary":"${summary}"}</agent-result>`;
    const opencodeOutput = [
      JSON.stringify({
        type: "text",
        part: { type: "text", text: resultText("first"), metadata: { openai: { phase: "final_answer" } } },
      }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: resultText("second"), metadata: { openai: { phase: "final_answer" } } },
      }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "Later prose.", metadata: { openai: { phase: "final_answer" } } },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).stdout).toBe(resultText("second"));
  });

  test("uses the latest final answer when none contains a result block", () => {
    const opencodeOutput = [
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "First answer.", metadata: { openai: { phase: "final_answer" } } },
      }),
      JSON.stringify({
        type: "text",
        part: { type: "text", text: "Latest answer.", metadata: { openai: { phase: "final_answer" } } },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(opencodeOutput).stdout).toBe("Latest answer.");
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

  test("classifies an unambiguous retryable 5xx provider error", () => {
    const output = JSON.stringify({
      type: "error",
      sessionID: "opencode-session",
      error: {
        name: "APIError",
        data: {
          message: "Our servers are currently overloaded. Please try again later.",
          statusCode: 503,
          isRetryable: true,
          responseHeaders: { authorization: "not included in the summary" },
        },
      },
    });

    const normalized = normalizeOpenCodeJsonOutput(output);
    expect(normalized).toMatchObject({
      nativeSessionId: "opencode-session",
      warning: "OpenCode APIError returned retryable HTTP 503.",
      retryableInterruption: { summary: "OpenCode APIError returned retryable HTTP 503." },
    });
    expect(normalized.warning).not.toContain("authorization");
  });

  test("redacts retryable provider response details from streamed output", () => {
    const output = JSON.stringify({
      type: "error",
      sessionID: "opencode-session",
      error: {
        name: "APIError",
        data: {
          message: "full provider response",
          statusCode: 503,
          isRetryable: true,
          responseHeaders: { authorization: "secret" },
        },
      },
    });

    expect(redactRetryableOpenCodeErrorLine(output)).toBe(
      JSON.stringify({
        type: "error",
        sessionID: "opencode-session",
        error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
      }),
    );
  });

  test("allows lifecycle records before a terminal retryable error", () => {
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "opencode-session", part: { type: "step-start" } }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "opencode-session",
        part: { type: "step-finish", tokens: { input: 10, output: 0 } },
      }),
      JSON.stringify({
        type: "error",
        sessionID: "opencode-session",
        error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(output)).toMatchObject({
      retryableInterruption: { summary: "OpenCode APIError returned retryable HTTP 503." },
    });
  });

  test.each([
    ["non-5xx", { statusCode: 429, isRetryable: true }],
    ["non-retryable", { statusCode: 503, isRetryable: false }],
    ["string status", { statusCode: "503", isRetryable: true }],
    ["missing retry metadata", { message: "overloaded" }],
  ])("does not classify a %s provider error as retryable", (_label, data) => {
    const output = JSON.stringify({ type: "error", error: { name: "APIError", data } });

    expect(normalizeOpenCodeJsonOutput(output).retryableInterruption).toBeUndefined();
  });

  test.each([undefined, "ProviderAuthError"])("does not classify an error named %s", (name) => {
    const output = JSON.stringify({
      type: "error",
      error: { ...(name ? { name } : {}), data: { statusCode: 503, isRetryable: true } },
    });

    expect(normalizeOpenCodeJsonOutput(output).retryableInterruption).toBeUndefined();
  });

  test("does not classify retryable errors mixed with usable output", () => {
    const output = [
      JSON.stringify({ type: "text", text: "Implemented the change." }),
      JSON.stringify({
        type: "error",
        error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
      }),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(output)).toMatchObject({ stdout: "Implemented the change." });
    expect(normalizeOpenCodeJsonOutput(output).retryableInterruption).toBeUndefined();
  });

  test("does not classify retryable errors after lifecycle records containing usable output", () => {
    const output = [
      JSON.stringify({
        type: "step_finish",
        part: { type: "step-finish", text: '<agent-result>{"schemaVersion":1}</agent-result>' },
      }),
      JSON.stringify({
        type: "error",
        error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
      }),
    ].join("\n");

    const normalized = normalizeOpenCodeJsonOutput(output);
    expect(normalized).toMatchObject({
      stdout: '<agent-result>{"schemaVersion":1}</agent-result>',
    });
    expect(normalized.retryableInterruption).toBeUndefined();
  });

  test("does not classify lifecycle records with result output or malformed part types", () => {
    const retryableError = JSON.stringify({
      type: "error",
      error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
    });
    const withResult = [
      JSON.stringify({ type: "step_finish", part: { type: "step-finish", result: "work output" } }),
      retryableError,
    ].join("\n");
    const malformedLifecycle = [JSON.stringify({ type: "step_finish", part: { type: "text" } }), retryableError].join("\n");

    expect(normalizeOpenCodeJsonOutput(withResult).retryableInterruption).toBeUndefined();
    expect(normalizeOpenCodeJsonOutput(malformedLifecycle).retryableInterruption).toBeUndefined();
  });

  test("does not classify a retryable error record containing usable output", () => {
    const output = JSON.stringify({
      type: "error",
      text: "Implemented the change.",
      error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
    });

    const normalized = normalizeOpenCodeJsonOutput(output);
    expect(normalized).toMatchObject({
      stdout: "Implemented the change.",
    });
    expect(normalized.retryableInterruption).toBeUndefined();
  });

  test("does not classify retryable errors mixed with non-record JSON output", () => {
    const output = [
      JSON.stringify({
        type: "error",
        error: { name: "APIError", data: { statusCode: 503, isRetryable: true } },
      }),
      JSON.stringify("ambiguous output"),
    ].join("\n");

    expect(normalizeOpenCodeJsonOutput(output).retryableInterruption).toBeUndefined();
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
