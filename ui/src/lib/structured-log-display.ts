import type { RenderedLogSegment } from "./log-display"

const LEVEL_PATTERN = /^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/
const KV_PATTERN = /([a-zA-Z_][a-zA-Z0-9_.-]*)=("(?:[^"\\]|\\.)*"|\S+)/g

const LEVEL_CLASSES: Record<string, string[]> = {
  INFO: ["text-sky-600", "dark:text-sky-300", "font-semibold"],
  DEBUG: ["text-slate-500", "dark:text-slate-400", "font-semibold"],
  TRACE: ["text-slate-500", "dark:text-slate-400", "font-semibold"],
  WARN: ["text-amber-600", "dark:text-amber-300", "font-semibold"],
  WARNING: ["text-amber-600", "dark:text-amber-300", "font-semibold"],
  ERROR: ["text-rose-600", "dark:text-rose-300", "font-semibold"],
  FATAL: ["text-rose-600", "dark:text-rose-300", "font-semibold"],
}

const TIMESTAMP_CLASSES = ["text-muted-foreground"]
const KEY_CLASSES = ["text-muted-foreground"]
const PUNCT_CLASSES = ["text-muted-foreground"]
const VALUE_CLASSES = ["text-foreground"]
const MESSAGE_CLASSES = ["text-foreground", "font-medium"]

const plain = (text: string, classes: string[]): RenderedLogSegment => ({
  text,
  classes,
  style: {},
})

const unquote = (raw: string): { text: string; quoted: boolean } => {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return {
      text: raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      quoted: true,
    }
  }
  return { text: raw, quoted: false }
}

export const parseStructuredLogLine = (line: string): RenderedLogSegment[] | null => {
  const timestampMatch = line.match(TIMESTAMP_PATTERN)
  if (!timestampMatch) {
    return null
  }

  let cursor = timestampMatch[0].length
  if (line[cursor] !== " " && line[cursor] !== "\t") {
    return null
  }

  const afterTimestamp = line.slice(cursor).replace(/^\s+/, "")
  const levelMatch = afterTimestamp.match(LEVEL_PATTERN)
  if (!levelMatch) {
    return null
  }

  const level = levelMatch[1].toUpperCase()
  const levelClasses = LEVEL_CLASSES[level] ?? LEVEL_CLASSES.INFO

  cursor += line.slice(cursor).indexOf(levelMatch[0]) + levelMatch[0].length
  const remainder = line.slice(cursor).replace(/^\s+/, "")

  const segments: RenderedLogSegment[] = [
    plain(timestampMatch[0], TIMESTAMP_CLASSES),
    plain(" ", []),
    plain(level, levelClasses),
  ]

  if (remainder.length === 0) {
    return segments
  }

  segments.push(plain(" ", []))

  KV_PATTERN.lastIndex = 0
  const pairs: { key: string; rawValue: string; index: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = KV_PATTERN.exec(remainder)) !== null) {
    pairs.push({
      key: match[1],
      rawValue: match[2],
      index: match.index,
      end: KV_PATTERN.lastIndex,
    })
  }

  if (pairs.length === 0) {
    segments.push(plain(remainder, VALUE_CLASSES))
    return segments
  }

  const lastPair = pairs[pairs.length - 1]
  const trailingMessage =
    lastPair.key === "message" && lastPair.end === remainder.length ? lastPair : null
  const inlinePairs = trailingMessage ? pairs.slice(0, -1) : pairs

  let kvCursor = 0
  const emitPair = (pair: { key: string; rawValue: string }) => {
    const { text, quoted } = unquote(pair.rawValue)
    segments.push(plain(pair.key, KEY_CLASSES))
    segments.push(plain("=", PUNCT_CLASSES))
    if (quoted) {
      segments.push(plain('"', PUNCT_CLASSES))
      segments.push(plain(text, VALUE_CLASSES))
      segments.push(plain('"', PUNCT_CLASSES))
    } else {
      segments.push(plain(text, VALUE_CLASSES))
    }
  }

  for (const pair of inlinePairs) {
    if (pair.index > kvCursor) {
      segments.push(plain(remainder.slice(kvCursor, pair.index), VALUE_CLASSES))
    }
    emitPair(pair)
    kvCursor = pair.end
  }

  const tailEnd = trailingMessage ? trailingMessage.index : remainder.length
  if (tailEnd > kvCursor) {
    segments.push(plain(remainder.slice(kvCursor, tailEnd), VALUE_CLASSES))
  }

  if (trailingMessage) {
    const { text } = unquote(trailingMessage.rawValue)
    segments.push(plain(text, MESSAGE_CLASSES))
  }

  return segments
}
