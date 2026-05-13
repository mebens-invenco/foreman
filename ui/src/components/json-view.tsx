import { JsonView as ReactJsonView } from "@uiw/react-json-view"
import { darkTheme } from "@uiw/react-json-view/dark"
import { lightTheme } from "@uiw/react-json-view/light"

import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"

type JsonViewProps = {
  value: unknown
  collapsed?: number | boolean
  className?: string
}

function isRenderableJsonObject(value: unknown): value is object {
  return typeof value === "object" && value !== null
}

export function JsonView({ value, collapsed = 2, className }: JsonViewProps) {
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === "dark" ? darkTheme : lightTheme

  const wrapperClasses = cn(
    "overflow-auto border border-border/70 bg-muted/35 p-3 font-mono text-xs leading-5",
    className
  )

  if (!isRenderableJsonObject(value)) {
    return (
      <pre className={cn(wrapperClasses, "whitespace-pre-wrap break-words text-foreground")}>
        {JSON.stringify(value)}
      </pre>
    )
  }

  return (
    <div className={wrapperClasses}>
      <ReactJsonView
        value={value}
        collapsed={collapsed}
        style={{
          ...theme,
          backgroundColor: "transparent",
          ["--w-rjv-background-color" as string]: "transparent",
          ["--w-rjv-font-family" as string]: "var(--font-mono)",
        }}
        displayDataTypes={false}
        displayObjectSize
        enableClipboard
        indentWidth={12}
        shortenTextAfterLength={120}
      />
    </div>
  )
}
