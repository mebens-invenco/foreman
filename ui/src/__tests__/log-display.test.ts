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

  test("renders foreman structured log lines with typed segments", () => {
    const raw = `2026-05-08T06:23:15.528Z INFO action="review" attemptNumber=1 component="attempt-executor" message="created execution attempt"\n`
    const buffer = appendLogChunk(createLogBuffer(), raw)
    const lines = getDisplayLines(buffer)
    const line = lines[0]

    expect(line).toBeDefined()

    const timestampSegment = line!.segments[0]
    expect(timestampSegment?.text).toBe("2026-05-08T06:23:15.528Z")
    expect(timestampSegment?.classes).toEqual(
      expect.arrayContaining(["text-muted-foreground"])
    )

    const levelSegment = line!.segments.find((segment) => segment.text === "INFO")
    expect(levelSegment).toBeDefined()
    expect(levelSegment?.classes).toEqual(
      expect.arrayContaining(["font-semibold"])
    )

    const reconstructed = line!.segments.map((segment) => segment.text).join("")
    expect(reconstructed).toContain(`action="review"`)
    expect(reconstructed.endsWith("created execution attempt")).toBe(true)

    const messageSegment = line!.segments.find(
      (segment) => segment.text === "created execution attempt"
    )
    expect(messageSegment?.classes).toEqual(
      expect.arrayContaining(["text-foreground", "font-medium"])
    )
  })

  test("tones WARN and ERROR levels distinctly", () => {
    const raw = [
      `2026-05-08T06:23:15.528Z WARN component="x" message="careful"`,
      `2026-05-08T06:23:15.528Z ERROR component="x" message="oh no"`,
      "",
    ].join("\n")
    const buffer = appendLogChunk(createLogBuffer(), raw)
    const lines = getDisplayLines(buffer)

    const warnLevel = lines[0]?.segments.find((segment) => segment.text === "WARN")
    const errorLevel = lines[1]?.segments.find((segment) => segment.text === "ERROR")

    expect(warnLevel?.classes.join(" ")).toMatch(/amber/)
    expect(errorLevel?.classes.join(" ")).toMatch(/rose/)
  })

  test("leaves non-structured plain lines unchanged", () => {
    const buffer = appendLogChunk(createLogBuffer(), "plain log without structure\n")
    const lines = getDisplayLines(buffer)

    expect(lineText(0, lines)).toBe("plain log without structure")
  })

  test("preserves unmatched text between key-value pairs", () => {
    const raw = `2026-05-08T06:23:15.528Z ERROR component="x" failed requestId=42\n`
    const buffer = appendLogChunk(createLogBuffer(), raw)
    const lines = getDisplayLines(buffer)
    const reconstructed = lines[0]?.segments.map((segment) => segment.text).join("") ?? ""

    expect(reconstructed).toContain("failed")
    expect(reconstructed).toContain(`component="x"`)
    expect(reconstructed).toContain("requestId=42")
  })
})
