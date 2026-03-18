import { describe, expect, test } from "vitest";

import { appendLogChunk, appendSyntheticLogLine, createLogBuffer, getDisplayLines, parseAnsiLine } from "../log-display";

const lineText = (index: number, lines: ReturnType<typeof getDisplayLines>): string =>
  lines[index]?.segments.map((segment) => segment.text).join("") ?? "";

describe("log display rendering", () => {
  test("renders common ANSI SGR styles as styled segments", () => {
    const rendered = parseAnsiLine("plain \u001b[1;2;3;4;9;31;46mstyled\u001b[22;23;24;29;39;49m end");

    expect(rendered.segments).toEqual([
      { text: "plain ", classes: [], style: {} },
      {
        text: "styled",
        classes: ["font-bold", "opacity-70", "italic", "underline", "line-through"],
        style: {
          color: "var(--ansi-red)",
          "background-color": "var(--ansi-cyan)",
        },
      },
      { text: " end", classes: [], style: {} },
    ]);
  });

  test("preserves blank lines and partial lines across streamed chunks", () => {
    let buffer = createLogBuffer();

    buffer = appendLogChunk(buffer, "alpha\n\nbr");
    let lines = getDisplayLines(buffer);
    expect(lines.map((_, index) => lineText(index, lines))).toEqual(["alpha", "", "br"]);

    buffer = appendLogChunk(buffer, "avo\n\ncharlie\n");
    lines = getDisplayLines(buffer);
    expect(lines.map((_, index) => lineText(index, lines))).toEqual(["alpha", "", "bravo", "", "charlie"]);
  });

  test("carries ANSI state across lines and resets after inverse formatting", () => {
    let buffer = createLogBuffer();
    buffer = appendLogChunk(buffer, "\u001b[31mred\nstill red\u001b[7m inverse\u001b[0m\nplain");

    const lines = getDisplayLines(buffer);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      segments: [{ text: "red", classes: [], style: { color: "var(--ansi-red)" } }],
    });
    expect(lines[1]).toEqual({
      segments: [
        { text: "still red", classes: [], style: { color: "var(--ansi-red)" } },
        {
          text: " inverse",
          classes: [],
          style: {
            color: "var(--ansi-default-background)",
            "background-color": "var(--ansi-red)",
          },
        },
      ],
    });
    expect(lines[2]).toEqual({ segments: [{ text: "plain", classes: [], style: {} }] });
  });

  test("resets ANSI state when inserting worker attempt change markers", () => {
    let buffer = createLogBuffer();
    buffer = appendLogChunk(buffer, "\u001b[32mgreen");
    buffer = appendSyntheticLogLine(buffer, "[worker switched to attempt-2]");
    buffer = appendLogChunk(buffer, "plain");

    const lines = getDisplayLines(buffer);

    expect(lines.map((_, index) => lineText(index, lines))).toEqual(["green", "[worker switched to attempt-2]", "plain"]);
    expect(lines[0]?.segments[0]?.style).toEqual({ color: "var(--ansi-green)" });
    expect(lines[2]?.segments[0]?.style).toEqual({});
  });
});
