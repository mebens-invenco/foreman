import { describe, expect, test } from "vitest";

import { renderAgentJsonLogLine } from "../lib/agent-json-log-display.js";

describe("renderAgentJsonLogLine", () => {
  test("renders OpenCode text and lifecycle records readably", () => {
    expect(renderAgentJsonLogLine(JSON.stringify({ type: "text", part: { text: "hello" } }))).toBe("hello");
    expect(renderAgentJsonLogLine(JSON.stringify({ type: "session", sessionID: "opencode-session" }))).toBe(
      "[session] session=opencode-session",
    );
  });

  test("renders Claude result records readably", () => {
    expect(renderAgentJsonLogLine(JSON.stringify({ type: "result", session_id: "claude-session", result: "final" }))).toBe("final");
  });

  test("leaves non-json and malformed json unchanged", () => {
    expect(renderAgentJsonLogLine("plain output")).toBe("plain output");
    expect(renderAgentJsonLogLine("{bad json")).toBe("{bad json");
  });

  test("suppresses noisy token records that have no text", () => {
    expect(renderAgentJsonLogLine(JSON.stringify({ type: "content_block_delta", delta: { stop: true } }))).toBeNull();
  });
});
