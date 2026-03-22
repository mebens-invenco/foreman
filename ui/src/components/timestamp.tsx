import { formatRelativeTimestamp, formatTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

type TimestampProps = {
  value: string | null | undefined;
  mode?: "stacked" | "absolute" | "relative";
  className?: string;
};

export function Timestamp({ value, mode = "stacked", className }: TimestampProps) {
  if (!value) {
    return <span className={cn("text-muted-foreground", className)}>-</span>;
  }

  const absolute = formatTimestamp(value);
  const relative = formatRelativeTimestamp(value);

  if (mode === "absolute") {
    return (
      <time className={className} dateTime={value} title={absolute}>
        {absolute}
      </time>
    );
  }

  if (mode === "relative") {
    return (
      <time className={className} dateTime={value} title={absolute}>
        {relative}
      </time>
    );
  }

  return (
    <time className={cn("flex flex-col gap-0.5", className)} dateTime={value} title={absolute}>
      <span className="text-sm text-foreground">{relative}</span>
      <span className="text-xs text-muted-foreground">{absolute}</span>
    </time>
  );
}
