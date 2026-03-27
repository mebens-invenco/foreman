import { SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type DataTableToolbarProps = {
  children?: React.ReactNode
  hasActiveFilters?: boolean
  onReset?: () => void
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  searchValue: string
}

export function DataTableToolbar({
  children,
  hasActiveFilters = false,
  onReset,
  onSearchChange,
  searchPlaceholder,
  searchValue,
}: DataTableToolbarProps) {
  return (
    <div className="border-b border-border/70 px-4 py-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-1 flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search table"
              className="pl-8"
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchPlaceholder}
              value={searchValue}
            />
          </div>
          {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
        </div>

        {hasActiveFilters && onReset ? (
          <Button onClick={onReset} size="default" variant="outline">
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  )
}
