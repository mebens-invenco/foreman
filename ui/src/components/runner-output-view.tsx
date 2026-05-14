import { JsonView } from "@/components/json-view"
import { cn } from "@/lib/utils"

type RunnerOutputViewProps = {
  content: string
  className?: string
}

const OPEN_TAG = "<agent-result>"
const CLOSE_TAG = "</agent-result>"

type Segment =
  | { kind: "text"; text: string }
  | { kind: "json"; value: object; raw: string }
  | { kind: "agent-result-raw"; text: string }

type ParsedBlock = {
  openStart: number
  closeEnd: number
  payload: string
  parsed: object | null
}

function tryParseObject(text: string): object | null {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value === "object" && value !== null) {
      return value
    }
    return null
  } catch {
    return null
  }
}

function findAgentResultBlocks(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  let searchEnd = content.length

  while (searchEnd > 0) {
    const closeStart = content.lastIndexOf(CLOSE_TAG, searchEnd)
    if (closeStart === -1) {
      break
    }

    const openStart = content.lastIndexOf(OPEN_TAG, closeStart)
    if (openStart === -1) {
      searchEnd = closeStart
      continue
    }

    const payload = content.slice(openStart + OPEN_TAG.length, closeStart).trim()
    blocks.push({
      openStart,
      closeEnd: closeStart + CLOSE_TAG.length,
      payload,
      parsed: tryParseObject(payload),
    })

    searchEnd = openStart
  }

  return blocks.reverse()
}

function splitContent(content: string): Segment[] {
  const trimmed = content.trim()

  const wholeJson = tryParseObject(trimmed)
  if (wholeJson !== null) {
    return [{ kind: "json", value: wholeJson, raw: trimmed }]
  }

  const blocks = findAgentResultBlocks(content)
  if (blocks.length === 0) {
    if (content.length === 0) {
      return []
    }
    return [{ kind: "text", text: content }]
  }

  const segments: Segment[] = []
  let cursor = 0

  for (const block of blocks) {
    if (block.openStart > cursor) {
      segments.push({ kind: "text", text: content.slice(cursor, block.openStart) })
    }

    if (block.parsed !== null) {
      segments.push({ kind: "json", value: block.parsed, raw: block.payload })
    } else {
      segments.push({
        kind: "agent-result-raw",
        text: content.slice(block.openStart, block.closeEnd),
      })
    }

    cursor = block.closeEnd
  }

  if (cursor < content.length) {
    segments.push({ kind: "text", text: content.slice(cursor) })
  }

  return segments
}

export function RunnerOutputView({ content, className }: RunnerOutputViewProps) {
  const segments = splitContent(content)

  if (segments.length === 0) {
    return (
      <pre
        className={cn(
          "overflow-auto border border-border/70 bg-muted/35 p-4 font-mono text-xs leading-6 text-muted-foreground",
          className
        )}
      >
        Runner output is empty.
      </pre>
    )
  }

  return (
    <div className={cn("space-y-2 overflow-auto", className)}>
      {segments.map((segment, index) => {
        if (segment.kind === "json") {
          return (
            <div key={`runner-output-${index}`}>
              <p className="mb-1 text-xxs tracking-[0.22em] text-muted-foreground uppercase">
                agent-result
              </p>
              <JsonView value={segment.value} collapsed={2} />
            </div>
          )
        }

        if (segment.kind === "agent-result-raw") {
          return (
            <pre
              key={`runner-output-${index}`}
              className="overflow-auto border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-xs leading-6 whitespace-pre-wrap break-words text-amber-900 dark:text-amber-200"
            >
              {segment.text}
            </pre>
          )
        }

        const text = segment.text
        if (text.trim().length === 0) {
          return null
        }
        return (
          <pre
            key={`runner-output-${index}`}
            className="overflow-auto border border-border/70 bg-muted/35 p-3 font-mono text-xs leading-6 whitespace-pre-wrap break-words text-foreground"
          >
            {text}
          </pre>
        )
      })}
    </div>
  )
}
