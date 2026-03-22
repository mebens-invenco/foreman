import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

type DetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
};

export function DetailSheet({ open, onOpenChange, title, description, children }: DetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full max-w-full flex-col gap-0 border-l border-border bg-background p-0 sm:max-w-2xl lg:max-w-3xl">
        <SheetHeader className="border-b border-border/70 bg-card/70 px-6 py-5 text-left">
          <SheetTitle className="text-left font-heading text-lg text-foreground">{title}</SheetTitle>
          {description ? <SheetDescription className="text-left text-sm text-muted-foreground">{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
