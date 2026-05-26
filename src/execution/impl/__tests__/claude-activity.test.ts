import { describe, expect, test } from "vitest";

import { normalizeClaudeActivityLine, normalizeClaudeJsonOutput } from "../claude-output.js";

// Captured Claude `-p --output-format json` fixtures. Each `result` line is
// the verbatim end-of-run JSON object Claude emits in this mode — one full
// JSON object on a single line carrying session id, final text, usage, and
// (when applicable) is_error / permission_denials.
const claudeFixtures = {
  result: JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1100,
    num_turns: 1,
    result: "Implemented the change.",
    session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 6,
      output_tokens: 5,
      cache_creation_input_tokens: 32460,
      cache_read_input_tokens: 24417,
    },
  }),
  // Real runner-test fake omits `type` and `subtype`; the runner reuses the
  // session id from `result`. Normalizer must still recognise the record by
  // its `result` string field.
  resultWithoutType: JSON.stringify({
    session_id: "claude-session",
    result: '<agent-result>{"schemaVersion":1}</agent-result>',
  }),
  resultErrored: JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Tool execution failed: rate-limited",
    session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
  }),
  resultWithDenials: JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Tried, but two permissions were denied.",
    session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
    permission_denials: [
      { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      "WebFetch",
    ],
  }),
  systemInit: JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
    model: "claude-opus-4-7",
    cwd: "/tmp/example",
  }),
  topLevelError: JSON.stringify({ type: "error", message: "Claude rate-limited" }),
};

describe("normalizeClaudeActivityLine — known Claude event shapes", () => {
  test("`type: result` fans out to assistant_message + token_usage", () => {
    const activities = normalizeClaudeActivityLine(claudeFixtures.result);
    expect(Array.isArray(activities)).toBe(true);
    const list = activities as Array<{ kind: string; message: string; payload?: Record<string, unknown> }>;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      kind: "assistant_message",
      message: "Implemented the change.",
      payload: expect.objectContaining({
        claudeType: "result",
        sessionId: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
        subtype: "success",
      }),
    });
    expect(list[1]).toMatchObject({
      kind: "token_usage",
      message: "Claude usage reported",
    });
    expect(list[1]?.payload?.tokensUsed).toEqual({
      inputTokens: 6,
      outputTokens: 5,
      cacheCreationInputTokens: 32460,
      cacheReadInputTokens: 24417,
    });
  });

  test("records without `type` but with a `result` string are still recognised", () => {
    // Matches the runner-test fake-claude shape that omits `type` entirely.
    const activities = normalizeClaudeActivityLine(claudeFixtures.resultWithoutType);
    expect(Array.isArray(activities)).toBe(true);
    expect((activities as { kind: string }[]).map((a) => a.kind)).toEqual(["assistant_message"]);
  });

  test("`is_error: true` and non-success subtype emit an error instead of assistant_message", () => {
    const activities = normalizeClaudeActivityLine(claudeFixtures.resultErrored);
    expect(Array.isArray(activities)).toBe(true);
    const list = activities as { kind: string; payload: Record<string, unknown> }[];
    expect(list[0]?.kind).toBe("error");
    expect(list[0]?.payload).toMatchObject({ subtype: "error_during_execution", isError: true });
  });

  test("permission_denials become per-entry warning activities", () => {
    const activities = normalizeClaudeActivityLine(claudeFixtures.resultWithDenials);
    const list = activities as { kind: string; message: string }[];
    const warningMessages = list.filter((a) => a.kind === "warning").map((a) => a.message);
    expect(warningMessages).toEqual([
      "Permission denied: Bash",
      "Permission denied: WebFetch",
    ]);
  });

  test("system init records become operation_started with session id", () => {
    expect(normalizeClaudeActivityLine(claudeFixtures.systemInit)).toMatchObject({
      kind: "operation_started",
      message: "Claude session initialised",
      payload: expect.objectContaining({
        claudeType: "system",
        subtype: "init",
        sessionId: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
      }),
    });
  });

  test("top-level error records become error", () => {
    expect(normalizeClaudeActivityLine(claudeFixtures.topLevelError)).toMatchObject({
      kind: "error",
      message: "Claude rate-limited",
    });
  });
});

describe("normalizeClaudeActivityLine — unknown / malformed lines", () => {
  test("empty / whitespace lines return null", () => {
    expect(normalizeClaudeActivityLine("")).toBeNull();
    expect(normalizeClaudeActivityLine("   ")).toBeNull();
  });

  test("non-JSON lines return null (parse failure is non-fatal)", () => {
    expect(normalizeClaudeActivityLine("not-json")).toBeNull();
    expect(normalizeClaudeActivityLine("{broken")).toBeNull();
  });

  test("JSON without a type or result field returns null (no misleading 'unknown' row)", () => {
    expect(normalizeClaudeActivityLine(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  test("unrecognised type without a result field returns null", () => {
    expect(normalizeClaudeActivityLine(JSON.stringify({ type: "future.event" }))).toBeNull();
  });
});

// PARKING LOT — Claude `--output-format stream-json` switch.
//
// ENG-5261 keeps Claude on `--output-format json` (single end-of-run record).
// If a future ticket switches to `stream-json`, the post-run extractor
// (`normalizeClaudeJsonOutput`) MUST still resolve all three of:
//   1. Final assistant result text (drives the saved attempt stdout).
//   2. Native session id (drives session resume).
//   3. Total token usage (drives token accounting / spend telemetry).
// The tests below pin those invariants against a stream-json-style multi-event
// sequence so any switch must keep them green.
describe("parking lot — Claude stream-json switch must keep these contracts", () => {
  const streamJsonSequence = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
      model: "claude-opus-4-7",
      cwd: "/tmp/example",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Working on it..." }],
      },
    }),
    JSON.stringify({
      type: "user",
      session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
      message: { role: "user", content: [{ type: "tool_result", content: "OK" }] },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "All done.",
      session_id: "654bffbb-887d-4b99-9c9e-d93afd40bbcd",
      usage: {
        input_tokens: 7,
        output_tokens: 9,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
    }),
  ].join("\n");

  test("normalizeClaudeJsonOutput still resolves final result, session id, and usage from a stream-json sequence", () => {
    const normalized = normalizeClaudeJsonOutput(streamJsonSequence);
    expect(normalized.stdout).toBe("All done.");
    expect(normalized.nativeSessionId).toBe("654bffbb-887d-4b99-9c9e-d93afd40bbcd");
    expect(normalized.tokensUsed).toEqual({
      inputTokens: 7,
      outputTokens: 9,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 200,
    });
  });

  test("normalizeClaudeActivityLine recognises the terminal result event in a stream-json sequence", () => {
    // The activity-line normalizer is fed line-by-line by `runAgentProcess`.
    // The `result` event at the tail of a stream-json sequence is the same
    // shape as the single-record `--output-format json` payload; this
    // assertion is the early-warning if a future switch ever changes that.
    const lines = streamJsonSequence.split("\n");
    const finalActivities = normalizeClaudeActivityLine(lines[lines.length - 1]!);
    const list = (Array.isArray(finalActivities) ? finalActivities : [finalActivities]).filter(Boolean) as {
      kind: string;
    }[];
    expect(list.map((a) => a.kind)).toEqual(["assistant_message", "token_usage"]);
  });
});
