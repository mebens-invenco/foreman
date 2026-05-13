import type { CSSProperties } from "react"
import { useMemo } from "react"

import { renderStaticLogContent } from "@/lib/log-display"
import type { RenderedLogLine } from "@/lib/log-display"
import { cn } from "@/lib/utils"

type LogLinesProps = {
  lines: RenderedLogLine[]
  keyPrefix?: string
}

export function LogLines({ lines, keyPrefix = "log" }: LogLinesProps) {
  return (
    <div className="m-0 whitespace-pre-wrap break-words">
      {lines.map((line, index) => (
        <div key={`${keyPrefix}-line-${index}`}>
          {line.segments.length === 0 ? (
            <span>&nbsp;</span>
          ) : (
            line.segments.map((segment, segmentIndex) => (
              <span
                key={`${keyPrefix}-segment-${index}-${segmentIndex}`}
                className={cn(segment.classes)}
                style={segment.style as CSSProperties}
              >
                {segment.text}
              </span>
            ))
          )}
        </div>
      ))}
    </div>
  )
}

type LogViewProps = {
  content: string
  className?: string
}

export function LogView({ content, className }: LogViewProps) {
  const lines = useMemo(() => renderStaticLogContent(content), [content])

  if (lines.length === 0) {
    return (
      <div className={cn("border border-border/70 bg-muted/35 p-4 text-sm text-muted-foreground", className)}>
        Log file is empty.
      </div>
    )
  }

  return (
    <div
      className={cn(
        "overflow-auto border border-border/70 bg-muted/35 p-4 font-mono text-xs leading-6 text-foreground",
        className
      )}
    >
      <LogLines lines={lines} keyPrefix="artifact-log" />
    </div>
  )
}
