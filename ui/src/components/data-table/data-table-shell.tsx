import { cn } from "@/lib/utils"

export function DataTableShell({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("border border-border/70 bg-card/75", className)}
      {...props}
    />
  )
}
