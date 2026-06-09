import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

type ForemanSwitchProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}

// A page-local on/off switch built on the Radix primitive so the shared,
// vendored components/ui surface stays untouched. Colour and sizing come from
// design tokens (primary / input / background) rather than literal values.
export function ForemanSwitch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: ForemanSwitchProps) {
  return (
    <SwitchPrimitive.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input"
      )}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform",
          "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5"
        )}
      />
    </SwitchPrimitive.Root>
  )
}
