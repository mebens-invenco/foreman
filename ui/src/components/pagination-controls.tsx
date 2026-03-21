import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

type PaginationControlsProps = {
  page: number;
  hasNext: boolean;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
};

export function PaginationControls({ page, hasNext, disabled = false, onPrevious, onNext }: PaginationControlsProps) {
  return (
    <div className="flex flex-col gap-3 border border-border/70 bg-card/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Page {page + 1}</div>
      <div className="flex items-center gap-2 self-end sm:self-auto">
        <Button type="button" variant="outline" size="sm" disabled={disabled || page <= 0} onClick={onPrevious}>
          <ChevronLeftIcon className="size-4" />
          Previous
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || !hasNext} onClick={onNext}>
          Next
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
