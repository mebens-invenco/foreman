import type { DataTableFilterOption } from "@/components/data-table/types"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

type DataTableFilterSelectProps = {
  allLabel: string
  label?: string
  onValueChange: (value: string) => void
  options: DataTableFilterOption[]
  value: string
} & Pick<React.ComponentProps<typeof SelectTrigger>, "className" | "disabled">

export function DataTableFilterSelect({
  allLabel,
  className,
  label,
  onValueChange,
  options,
  value,
  ...props
}: DataTableFilterSelectProps) {
  return (
    <Select onValueChange={onValueChange} value={value}>
      <SelectTrigger
        aria-label={label ?? allLabel}
        className={cn("min-w-36", className)}
        {...props}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
