type NamedAnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "bright-black"
  | "bright-red"
  | "bright-green"
  | "bright-yellow"
  | "bright-blue"
  | "bright-magenta"
  | "bright-cyan"
  | "bright-white";

type AnsiColor =
  | { type: "named"; value: NamedAnsiColor }
  | { type: "palette"; value: number }
  | { type: "rgb"; red: number; green: number; blue: number };

type AnsiStyleState = {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  inverse: boolean;
  foreground: AnsiColor | null;
  background: AnsiColor | null;
};

export type RenderedLogSegment = {
  text: string;
  classes: string[];
  style: Record<string, string>;
};

export type RenderedLogLine = {
  segments: RenderedLogSegment[];
};

export type LogBuffer = {
  committedLines: RenderedLogLine[];
  pendingRawLine: string;
  pendingLine: RenderedLogLine | null;
  parserState: AnsiStyleState;
  pendingLineStartState: AnsiStyleState;
};

const MAX_LOG_LINES = 500;

const BASIC_COLORS: readonly NamedAnsiColor[] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const BRIGHT_COLORS: readonly NamedAnsiColor[] = [
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
];

const CSI_PATTERN = /\u001b\[([0-9:;?]*)?([ -/]*)?([@-~])/g;

const createAnsiStyleState = (): AnsiStyleState => ({
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strikethrough: false,
  inverse: false,
  foreground: null,
  background: null,
});

const cloneAnsiColor = (color: AnsiColor | null): AnsiColor | null => {
  if (color === null) {
    return null;
  }

  if (color.type === "rgb") {
    return { ...color };
  }

  return { ...color };
};

const cloneAnsiStyleState = (state: AnsiStyleState): AnsiStyleState => ({
  bold: state.bold,
  dim: state.dim,
  italic: state.italic,
  underline: state.underline,
  strikethrough: state.strikethrough,
  inverse: state.inverse,
  foreground: cloneAnsiColor(state.foreground),
  background: cloneAnsiColor(state.background),
});

const ansiColorToCss = (color: AnsiColor): string => {
  if (color.type === "named") {
    return `var(--ansi-${color.value})`;
  }

  if (color.type === "rgb") {
    return `rgb(${color.red} ${color.green} ${color.blue})`;
  }

  if (color.value < 16) {
    return `var(--ansi-${color.value < 8 ? BASIC_COLORS[color.value] : BRIGHT_COLORS[color.value - 8]})`;
  }

  if (color.value < 232) {
    const index = color.value - 16;
    const red = Math.floor(index / 36);
    const green = Math.floor((index % 36) / 6);
    const blue = index % 6;
    const channel = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
    return `rgb(${channel(red)} ${channel(green)} ${channel(blue)})`;
  }

  const level = 8 + (color.value - 232) * 10;
  return `rgb(${level} ${level} ${level})`;
};

const createRenderedSegment = (text: string, state: AnsiStyleState): RenderedLogSegment => {
  const classes: string[] = [];
  const style: Record<string, string> = {};

  if (state.bold) {
    classes.push("font-bold");
  }
  if (state.dim) {
    classes.push("opacity-70");
  }
  if (state.italic) {
    classes.push("italic");
  }
  if (state.underline) {
    classes.push("underline");
  }
  if (state.strikethrough) {
    classes.push("line-through");
  }

  const foreground = state.foreground ? ansiColorToCss(state.foreground) : null;
  const background = state.background ? ansiColorToCss(state.background) : null;

  if (state.inverse) {
    style.color = background ?? "var(--ansi-default-background)";
    style["background-color"] = foreground ?? "var(--ansi-default-foreground)";
  } else {
    if (foreground) {
      style.color = foreground;
    }
    if (background) {
      style["background-color"] = background;
    }
  }

  return { text, classes, style };
};

const mergeRenderedSegments = (segments: RenderedLogSegment[]): RenderedLogSegment[] => {
  const merged: RenderedLogSegment[] = [];

  for (const segment of segments) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.classes.join(" ") === segment.classes.join(" ") &&
      JSON.stringify(previous.style) === JSON.stringify(segment.style)
    ) {
      previous.text += segment.text;
      continue;
    }

    merged.push({
      text: segment.text,
      classes: [...segment.classes],
      style: { ...segment.style },
    });
  }

  return merged;
};

const setNamedColor = (state: AnsiStyleState, target: "foreground" | "background", value: number, bright: boolean): void => {
  const colors = bright ? BRIGHT_COLORS : BASIC_COLORS;
  state[target] = { type: "named", value: colors[value] };
};

const applyExtendedColor = (state: AnsiStyleState, target: "foreground" | "background", codes: number[], index: number): number => {
  const mode = codes[index + 1];
  if (mode === 5) {
    const palette = codes[index + 2];
    if (palette !== undefined) {
      state[target] = { type: "palette", value: Math.max(0, Math.min(255, palette)) };
      return index + 2;
    }
    return codes.length;
  }

  if (mode === 2) {
    const red = codes[index + 2];
    const green = codes[index + 3];
    const blue = codes[index + 4];
    if (red !== undefined && green !== undefined && blue !== undefined) {
      state[target] = {
        type: "rgb",
        red: Math.max(0, Math.min(255, red)),
        green: Math.max(0, Math.min(255, green)),
        blue: Math.max(0, Math.min(255, blue)),
      };
      return index + 4;
    }
    return codes.length;
  }

  return index;
};

const applySgrCodes = (state: AnsiStyleState, codes: number[]): void => {
  const normalizedCodes = codes.length === 0 ? [0] : codes;

  for (let index = 0; index < normalizedCodes.length; index += 1) {
    const code = normalizedCodes[index] ?? 0;
    if (code === 0) {
      Object.assign(state, createAnsiStyleState());
      continue;
    }

    if (code === 1) {
      state.bold = true;
      continue;
    }

    if (code === 2) {
      state.dim = true;
      continue;
    }

    if (code === 3) {
      state.italic = true;
      continue;
    }

    if (code === 4) {
      state.underline = true;
      continue;
    }

    if (code === 7) {
      state.inverse = true;
      continue;
    }

    if (code === 9) {
      state.strikethrough = true;
      continue;
    }

    if (code === 21 || code === 22) {
      state.bold = false;
      state.dim = false;
      continue;
    }

    if (code === 23) {
      state.italic = false;
      continue;
    }

    if (code === 24) {
      state.underline = false;
      continue;
    }

    if (code === 27) {
      state.inverse = false;
      continue;
    }

    if (code === 29) {
      state.strikethrough = false;
      continue;
    }

    if (code >= 30 && code <= 37) {
      setNamedColor(state, "foreground", code - 30, false);
      continue;
    }

    if (code === 39) {
      state.foreground = null;
      continue;
    }

    if (code >= 40 && code <= 47) {
      setNamedColor(state, "background", code - 40, false);
      continue;
    }

    if (code === 49) {
      state.background = null;
      continue;
    }

    if (code >= 90 && code <= 97) {
      setNamedColor(state, "foreground", code - 90, true);
      continue;
    }

    if (code >= 100 && code <= 107) {
      setNamedColor(state, "background", code - 100, true);
      continue;
    }

    if (code === 38) {
      index = applyExtendedColor(state, "foreground", normalizedCodes, index);
      continue;
    }

    if (code === 48) {
      index = applyExtendedColor(state, "background", normalizedCodes, index);
    }
  }
};

export const parseAnsiLine = (
  line: string,
  initialState: AnsiStyleState = createAnsiStyleState(),
): { segments: RenderedLogSegment[]; state: AnsiStyleState } => {
  const state = cloneAnsiStyleState(initialState);
  const segments: RenderedLogSegment[] = [];
  let textStart = 0;
  let match: RegExpExecArray | null;

  CSI_PATTERN.lastIndex = 0;

  while ((match = CSI_PATTERN.exec(line)) !== null) {
    if (match.index > textStart) {
      segments.push(createRenderedSegment(line.slice(textStart, match.index), state));
    }

    if (match[3] === "m") {
      const codes = (match[1] ?? "")
        .split(";")
        .filter((value) => value.length > 0)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value));
      applySgrCodes(state, codes);
    }

    textStart = CSI_PATTERN.lastIndex;
  }

  if (textStart < line.length) {
    segments.push(createRenderedSegment(line.slice(textStart), state));
  }

  return { segments: mergeRenderedSegments(segments), state };
};

const normalizeLogChunk = (chunk: string): string => chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const splitCompleteLines = (text: string): { lines: string[]; remainder: string } => {
  if (text.length === 0) {
    return { lines: [], remainder: "" };
  }

  const parts = text.split("\n");
  const endsWithNewline = text.endsWith("\n");
  const remainder = endsWithNewline ? "" : (parts.pop() ?? "");
  const lines = endsWithNewline ? parts.slice(0, -1) : parts;
  return { lines, remainder };
};

const limitDisplayLines = (lines: RenderedLogLine[]): RenderedLogLine[] => lines.slice(-MAX_LOG_LINES);

export const createLogBuffer = (): LogBuffer => ({
  committedLines: [],
  pendingRawLine: "",
  pendingLine: null,
  parserState: createAnsiStyleState(),
  pendingLineStartState: createAnsiStyleState(),
});

export const appendLogChunk = (buffer: LogBuffer, chunk: string): LogBuffer => {
  if (chunk.length === 0) {
    return buffer;
  }

  const combined = buffer.pendingRawLine + normalizeLogChunk(chunk);
  const { lines, remainder } = splitCompleteLines(combined);
  let nextState = cloneAnsiStyleState(buffer.pendingLineStartState);
  const renderedLines = lines.map((line) => {
    const rendered = parseAnsiLine(line, nextState);
    nextState = rendered.state;
    return { segments: rendered.segments };
  });
  const pendingLineStartState = cloneAnsiStyleState(nextState);
  const pendingLine = remainder.length > 0 ? { segments: parseAnsiLine(remainder, pendingLineStartState).segments } : null;

  return {
    committedLines: limitDisplayLines([...buffer.committedLines, ...renderedLines]),
    pendingRawLine: remainder,
    pendingLine,
    parserState: cloneAnsiStyleState(nextState),
    pendingLineStartState,
  };
};

export const appendSyntheticLogLine = (buffer: LogBuffer, text: string): LogBuffer => ({
  committedLines: limitDisplayLines([
    ...getDisplayLines(buffer),
    {
      segments: text.length > 0 ? [{ text, classes: [], style: {} }] : [],
    },
  ]),
  pendingRawLine: "",
  pendingLine: null,
  parserState: createAnsiStyleState(),
  pendingLineStartState: createAnsiStyleState(),
});

export const getDisplayLines = (buffer: LogBuffer): RenderedLogLine[] =>
  limitDisplayLines(buffer.pendingLine ? [...buffer.committedLines, buffer.pendingLine] : buffer.committedLines);

export const renderSegmentStyle = (style: Record<string, string>): string =>
  Object.entries(style)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
