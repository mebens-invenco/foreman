import { useEffect, useMemo, useRef, useState } from "react";

import type { RenderedLogLine } from "@/lib/log-display";

type LogViewerProps = {
  lines: RenderedLogLine[];
  emptyMessage?: string;
};

export function LogViewer({ lines, emptyMessage = "No log output yet." }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !stickToBottom) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [lines, stickToBottom]);

  const rendered = useMemo(
    () =>
      lines.map((line, lineIndex) => (
        <div key={`line-${lineIndex}`}>
          {line.segments.map((segment, segmentIndex) => (
            <span
              key={`segment-${lineIndex}-${segmentIndex}`}
              className={segment.classes.join(" ")}
              style={segment.style}
            >
              {segment.text}
            </span>
          ))}
        </div>
      )),
    [lines],
  );

  return (
    <div
      ref={containerRef}
      className="border border-border bg-[linear-gradient(180deg,color-mix(in_oklab,var(--card)_90%,transparent),color-mix(in_oklab,var(--background)_96%,transparent))]"
      onScroll={(event) => {
        const element = event.currentTarget;
        const delta = element.scrollHeight - element.scrollTop - element.clientHeight;
        setStickToBottom(delta < 40);
      }}
    >
      {lines.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">{emptyMessage}</div>
      ) : (
        <pre className="m-0 min-h-[18rem] whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground">{rendered}</pre>
      )}
    </div>
  );
}
