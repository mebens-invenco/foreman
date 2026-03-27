import type { Column } from "@tanstack/react-table"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type DataTableColumnHeaderProps<TData, TValue> = {
  className?: string
  column: Column<TData, TValue>
  title: string
}

function SortIcon({ direction }: { direction: false | "asc" | "desc" }) {
  if (direction === "asc") {
    return <ArrowUpIcon className="size-3" />
  }

  if (direction === "desc") {
    return <ArrowDownIcon className="size-3" />
  }

  return <ArrowUpDownIcon className="size-3" />
}

export function DataTableColumnHeader<TData, TValue>({
  className,
  column,
  title,
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <span className={cn("text-foreground", className)}>{title}</span>
  }

  return (
    <Button
      className={cn("-ml-2 h-7 px-2 text-xs", className)}
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      size="xs"
      variant="ghost"
    >
      <span>{title}</span>
      <SortIcon direction={column.getIsSorted()} />
    </Button>
  )
}
