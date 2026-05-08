import { describe, expect, test } from "vitest";

import { extractClaudeUsage, normalizeClaudeJsonOutput } from "../claude-output.js";

describe("normalizeClaudeJsonOutput", () => {
  test("returns a warning and the raw stdout when JSON parsing fails", () => {
    expect(normalizeClaudeJsonOutput("{bad json")).toMatchObject({
      stdout: "{bad json",
      warning: expect.stringContaining("Failed to parse Claude JSON output"),
    });
  });

  test("only extracts the result record's text", () => {
    const claudeOutput = [
      JSON.stringify({ type: "assistant", text: "intermediate" }),
      JSON.stringify({ type: "result", result: "final" }),
    ].join("\n");
    expect(normalizeClaudeJsonOutput(claudeOutput).stdout).toBe("final");
  });

  test("extracts token usage from the result event's usage object", () => {
    // Empirical fixture captured from `claude -p --output-format json --session-id ...`
    // (single fresh call). `input_tokens` is already NEW input only.
    const claudeOutput = JSON.stringify({
      type: "result",
      result: "one",
      session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_creation_input_tokens: 32460,
        cache_read_input_tokens: 24417,
      },
    });
    expect(normalizeClaudeJsonOutput(claudeOutput).tokensUsed).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      cacheCreationInputTokens: 32460,
      cacheReadInputTokens: 24417,
    });

    const claudeOutputNoUsage = JSON.stringify({ type: "result", result: "final" });
    expect(normalizeClaudeJsonOutput(claudeOutputNoUsage).tokensUsed).toBeUndefined();
  });
});

describe("extractClaudeUsage", () => {
  test("returns undefined when no usage fields are present", () => {
    expect(extractClaudeUsage({})).toBeUndefined();
  });
});
