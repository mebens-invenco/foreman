import { describe, expect, test } from "vitest";

import { normalizeOpenCodeActivityLine } from "../opencode-output.js";

// Captured OpenCode `run --format json` fixtures. Each line is a verbatim
// shape observed from real opencode runs (cross-checked against the same
// shapes the post-run normalizer already parses in `opencode-output.test.ts`
// and `runner.test.ts`). Keep assertions tight so an upstream shape change
// surfaces here rather than silently dropping live observability.
const sessionId = "ses_1fa1181e0ffesZ25ctVlinDFgI";

const opencodeFixtures = {
  session: JSON.stringify({ type: "session", sessionID: sessionId }),
  stepStart: JSON.stringify({
    type: "step_start",
    sessionID: sessionId,
    part: { type: "step-start" },
  }),
  stepFinish: JSON.stringify({
    type: "step_finish",
    sessionID: sessionId,
    part: {
      type: "step-finish",
      reason: "stop",
      tokens: { total: 17074, input: 17052, output: 7, reasoning: 15, cache: { write: 0, read: 0 } },
      cost: 0,
    },
  }),
  stepFinishWithoutTokens: JSON.stringify({
    type: "step_finish",
    sessionID: sessionId,
    part: { type: "step-finish", reason: "stop" },
  }),
  textFinalAnswer: JSON.stringify({
    type: "text",
    sessionID: sessionId,
    part: {
      type: "text",
      text: "Implemented the change.",
      metadata: { openai: { phase: "final_answer" } },
    },
  }),
  textCommentary: JSON.stringify({
    type: "text",
    sessionID: sessionId,
    part: {
      type: "text",
      text: "Thinking about how to approach this...",
      metadata: { openai: { phase: "commentary" } },
    },
  }),
  textUnphased: JSON.stringify({
    type: "text",
    sessionID: sessionId,
    part: { type: "text", text: "Plain text output" },
  }),
  message: JSON.stringify({
    type: "message",
    sessionID: sessionId,
    part: { text: "runner output line" },
  }),
  final: JSON.stringify({
    type: "final",
    text: '<agent-result>{"schemaVersion":1}</agent-result>',
  }),
  error: JSON.stringify({ type: "error", message: "JSON parsing failed: expected value" }),
  errorPart: JSON.stringify({
    type: "text",
    sessionID: sessionId,
    part: { type: "error", error: { message: "tool execution failed" } },
  }),
  // Tool/command/patch parts: shape varies by opencode version; until a
  // captured fixture pins the exact field layout, the normalizer falls
  // through to kind: "unknown" but still preserves opencodeType + partType
  // so the activity feed shows the operation occurred.
  unverifiedToolPart: JSON.stringify({
    type: "tool",
    sessionID: sessionId,
    part: { type: "tool-call", tool: "bash", input: { command: "ls" } },
  }),
};

describe("normalizeOpenCodeActivityLine — known OpenCode event shapes", () => {
  test("session events become operation_started with the sessionID", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.session)).toMatchObject({
      kind: "operation_started",
      message: "OpenCode session started",
      payload: expect.objectContaining({ opencodeType: "session", sessionId }),
    });
  });

  test("step_start becomes operation_started", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.stepStart)).toMatchObject({
      kind: "operation_started",
      message: "OpenCode step started",
      payload: expect.objectContaining({ opencodeType: "step_start", partType: "step-start" }),
    });
  });

  test("step_finish fans out to token_usage + operation_finished and surfaces normalized usage", () => {
    const activities = normalizeOpenCodeActivityLine(opencodeFixtures.stepFinish);
    expect(Array.isArray(activities)).toBe(true);
    const list = activities as { kind: string; payload: Record<string, unknown> }[];
    expect(list.map((a) => a.kind)).toEqual(["token_usage", "operation_finished"]);
    expect(list[0]?.payload?.tokensUsed).toEqual({
      inputTokens: 17052,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 15,
    });
  });

  test("step_finish without tokens still emits operation_finished (no token_usage row)", () => {
    const activities = normalizeOpenCodeActivityLine(opencodeFixtures.stepFinishWithoutTokens);
    expect(Array.isArray(activities)).toBe(true);
    const list = activities as { kind: string }[];
    expect(list.map((a) => a.kind)).toEqual(["operation_finished"]);
  });

  test("text with final_answer phase becomes assistant_message", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.textFinalAnswer)).toMatchObject({
      kind: "assistant_message",
      message: "Implemented the change.",
      payload: expect.objectContaining({ phase: "final_answer" }),
    });
  });

  test("text with commentary phase becomes reasoning so it does not crowd assistant_message counts", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.textCommentary)).toMatchObject({
      kind: "reasoning",
      message: "Thinking about how to approach this...",
      payload: expect.objectContaining({ phase: "commentary" }),
    });
  });

  test("text without an openai phase falls back to assistant_message", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.textUnphased)).toMatchObject({
      kind: "assistant_message",
      message: "Plain text output",
    });
  });

  test("message events become assistant_message using part.text", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.message)).toMatchObject({
      kind: "assistant_message",
      message: "runner output line",
    });
  });

  test("final events become assistant_message using top-level text", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.final)).toMatchObject({
      kind: "assistant_message",
      message: '<agent-result>{"schemaVersion":1}</agent-result>',
    });
  });

  test("top-level error events become error and carry the message", () => {
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.error)).toMatchObject({
      kind: "error",
      message: "JSON parsing failed: expected value",
    });
  });

  test("part.type=error inside a text wrapper still becomes error", () => {
    const activity = normalizeOpenCodeActivityLine(opencodeFixtures.errorPart);
    expect(activity).toMatchObject({ kind: "error" });
    // The message comes from the nested error.message field via openCodeErrorSummary.
    expect((activity as { message: string }).message).toContain("tool execution failed");
  });
});

describe("normalizeOpenCodeActivityLine — unverified shapes fall through to kind 'unknown'", () => {
  test("tool / command / patch parts whose shape is not pinned by a fixture surface as 'unknown'", () => {
    // Conservative on purpose: emitting 'unknown' (rather than a guessed
    // tool_started kind) keeps live observability honest while still
    // surfacing that the runner emitted activity. A follow-up ticket that
    // captures a real fixture can promote this to tool_started/tool_finished.
    expect(normalizeOpenCodeActivityLine(opencodeFixtures.unverifiedToolPart)).toMatchObject({
      kind: "unknown",
      message: "OpenCode tool:tool-call",
      payload: expect.objectContaining({ opencodeType: "tool", partType: "tool-call" }),
    });
  });
});

describe("normalizeOpenCodeActivityLine — unknown / malformed lines", () => {
  test("empty / whitespace lines return null", () => {
    expect(normalizeOpenCodeActivityLine("")).toBeNull();
    expect(normalizeOpenCodeActivityLine("   ")).toBeNull();
  });

  test("non-JSON lines return null (parse failure is non-fatal)", () => {
    expect(normalizeOpenCodeActivityLine("not-json")).toBeNull();
    expect(normalizeOpenCodeActivityLine("{broken")).toBeNull();
  });

  test("JSON without a `type` field returns null", () => {
    expect(normalizeOpenCodeActivityLine(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  test("text-shaped record with no text content returns null (don't emit empty assistant_message)", () => {
    expect(
      normalizeOpenCodeActivityLine(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text" } })),
    ).toBeNull();
  });
});
