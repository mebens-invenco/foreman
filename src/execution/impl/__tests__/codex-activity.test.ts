import { describe, expect, test } from "vitest";

import { normalizeCodexActivityLine } from "../codex-output.js";

// Captured Codex JSON fixtures. Each line is a verbatim shape observed from
// `codex exec --json` runs. Keep the assertions tight enough that an upstream
// shape change is caught here rather than silently dropped on the wire.
const codexFixtures = {
  threadStarted: JSON.stringify({ type: "thread.started", thread_id: "019e05ee-8b70-7ff1-812b-ac29b94d03ec" }),
  turnStarted: JSON.stringify({ type: "turn.started" }),
  turnCompleted: JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 20341, cached_input_tokens: 3456, output_tokens: 5, reasoning_output_tokens: 0 },
  }),
  agentMessage: JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "I will now run the tests." },
  }),
  reasoning: JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "reasoning", text: "Plan: read the file, then patch it." },
  }),
  commandStarted: JSON.stringify({
    type: "item.started",
    item: { id: "item_2", type: "command_execution", command: "yarn test" },
  }),
  commandCompleted: JSON.stringify({
    type: "item.completed",
    item: { id: "item_2", type: "command_execution", text: "yarn test", exit_code: 0 },
  }),
  toolStarted: JSON.stringify({
    type: "item.started",
    item: { id: "item_3", type: "tool_call", command: "search" },
  }),
  toolCompleted: JSON.stringify({
    type: "item.completed",
    item: { id: "item_3", type: "tool_call", text: "search returned 4 files" },
  }),
  fileChange: JSON.stringify({
    type: "item.completed",
    item: { id: "item_4", type: "file_change", text: "patched src/example.ts" },
  }),
  errorItem: JSON.stringify({
    type: "item.completed",
    item: { id: "item_5", type: "error", text: "command failed: exit 2" },
  }),
  error: JSON.stringify({ type: "error", message: "Codex rate-limited" }),
};

describe("normalizeCodexActivityLine — known Codex event shapes", () => {
  test("thread.started becomes operation_started with threadId", () => {
    const activity = normalizeCodexActivityLine(codexFixtures.threadStarted);
    expect(activity).toMatchObject({
      kind: "operation_started",
      message: "Codex thread started",
      payload: expect.objectContaining({ codexType: "thread.started", threadId: "019e05ee-8b70-7ff1-812b-ac29b94d03ec" }),
    });
  });

  test("turn.started becomes operation_started", () => {
    expect(normalizeCodexActivityLine(codexFixtures.turnStarted)).toMatchObject({
      kind: "operation_started",
      payload: { codexType: "turn.started" },
    });
  });

  test("turn.completed becomes token_usage and surfaces normalized usage", () => {
    const activity = normalizeCodexActivityLine(codexFixtures.turnCompleted);
    expect(activity).toMatchObject({
      kind: "token_usage",
      message: "Codex turn completed",
    });
    expect(activity?.payload?.tokensUsed).toEqual({
      inputTokens: 20341 - 3456,
      outputTokens: 5,
      cacheReadInputTokens: 3456,
      reasoningOutputTokens: 0,
    });
  });

  test("item.completed agent_message becomes assistant_message with text", () => {
    expect(normalizeCodexActivityLine(codexFixtures.agentMessage)).toMatchObject({
      kind: "assistant_message",
      message: "I will now run the tests.",
      payload: expect.objectContaining({ itemType: "agent_message", itemId: "item_0" }),
    });
  });

  test("reasoning items become reasoning", () => {
    expect(normalizeCodexActivityLine(codexFixtures.reasoning)).toMatchObject({
      kind: "reasoning",
      message: "Plan: read the file, then patch it.",
    });
  });

  test("command_execution start/finish produce paired kinds", () => {
    expect(normalizeCodexActivityLine(codexFixtures.commandStarted)).toMatchObject({
      kind: "command_started",
      payload: expect.objectContaining({ itemType: "command_execution" }),
    });
    expect(normalizeCodexActivityLine(codexFixtures.commandCompleted)).toMatchObject({
      kind: "command_finished",
      payload: expect.objectContaining({ itemType: "command_execution" }),
    });
  });

  test("tool calls produce tool_started/tool_finished", () => {
    expect(normalizeCodexActivityLine(codexFixtures.toolStarted)?.kind).toBe("tool_started");
    expect(normalizeCodexActivityLine(codexFixtures.toolCompleted)?.kind).toBe("tool_finished");
  });

  test("file_change items become diff", () => {
    expect(normalizeCodexActivityLine(codexFixtures.fileChange)).toMatchObject({
      kind: "diff",
      message: "patched src/example.ts",
    });
  });

  test("error items and top-level error events become error", () => {
    expect(normalizeCodexActivityLine(codexFixtures.errorItem)?.kind).toBe("error");
    expect(normalizeCodexActivityLine(codexFixtures.error)).toMatchObject({
      kind: "error",
      message: "Codex rate-limited",
    });
  });
});

describe("normalizeCodexActivityLine — unknown / malformed lines", () => {
  test("empty / whitespace lines return null", () => {
    expect(normalizeCodexActivityLine("")).toBeNull();
    expect(normalizeCodexActivityLine("    ")).toBeNull();
  });

  test("non-JSON lines return null (parse failure is non-fatal)", () => {
    expect(normalizeCodexActivityLine("not-json")).toBeNull();
    expect(normalizeCodexActivityLine("{broken")).toBeNull();
  });

  test("JSON without a `type` field returns null", () => {
    expect(normalizeCodexActivityLine(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  test("unrecognised top-level type returns kind 'unknown'", () => {
    expect(normalizeCodexActivityLine(JSON.stringify({ type: "future.event" }))).toMatchObject({
      kind: "unknown",
      message: "Codex future.event",
      payload: { codexType: "future.event" },
    });
  });

  test("item.completed with unrecognised item.type returns kind 'unknown'", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_x", type: "future_kind", text: "future" },
    });
    expect(normalizeCodexActivityLine(line)).toMatchObject({
      kind: "unknown",
      payload: expect.objectContaining({ itemType: "future_kind" }),
    });
  });
});
