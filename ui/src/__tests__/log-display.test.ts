import { describe, expect, test } from "vitest"

import { appendLogChunk, createLogBuffer, getDisplayLines } from "../lib/log-display"

const lineText = (index: number, lines: ReturnType<typeof getDisplayLines>): string =>
  lines[index]?.segments.map((segment) => segment.text).join("") ?? ""

describe("log-display", () => {
  test("renders JSON runner records from initial chunks readably", () => {
    const buffer = appendLogChunk(
      createLogBuffer(),
      [
        JSON.stringify({ type: "message", sessionID: "opencode-session", part: { text: "OpenCode text" } }),
        JSON.stringify({ type: "result", session_id: "claude-session", result: "Claude final" }),
        "plain output",
      ].join("\n") + "\n"
    )
    const lines = getDisplayLines(buffer)

    expect(lineText(0, lines)).toBe("OpenCode text")
    expect(lineText(1, lines)).toBe("Claude final")
    expect(lineText(2, lines)).toBe("plain output")
  })

  test("renders streamed partial JSON chunks after the line completes", () => {
    const first = appendLogChunk(createLogBuffer(), '{"type":"text","text":"streamed')
    const second = appendLogChunk(first, ' text"}\n')
    const lines = getDisplayLines(second)

    expect(lines).toHaveLength(1)
    expect(lineText(0, lines)).toBe("streamed text")
  })

  test("falls back safely for malformed JSON and suppresses empty deltas", () => {
    const buffer = appendLogChunk(
      createLogBuffer(),
      `${JSON.stringify({ type: "token_delta", token_count: 1 })}\n{bad json\n`
    )
    const lines = getDisplayLines(buffer)

    expect(lines).toHaveLength(1)
    expect(lineText(0, lines)).toBe("{bad json")
  })

  test("preserves ANSI rendering for extracted JSON text", () => {
    const buffer = appendLogChunk(createLogBuffer(), `${JSON.stringify({ type: "text", text: "\u001b[31mred\u001b[0m" })}\n`)
    const lines = getDisplayLines(buffer)

    expect(lineText(0, lines)).toBe("red")
    expect(lines[0]?.segments[0]?.style.color).toBe("var(--ansi-red)")
  })
})
