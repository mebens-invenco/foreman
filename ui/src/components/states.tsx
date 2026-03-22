import type { ReactNode } from "react";
import { AlertCircleIcon, InboxIcon, LoaderCircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type StateCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  className?: string | undefined;
};

function StateCard({ icon, title, description, className }: StateCardProps) {
  return (
    <div className={cn("border border-dashed border-border/80 bg-card/60 px-5 py-8 text-center", className)}>
      <div className="mx-auto flex size-10 items-center justify-center border border-border/80 bg-background text-muted-foreground">
        {icon}
      </div>
      <div className="mt-4 text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

type SimpleStateProps = {
  label: string;
  className?: string | undefined;
};

export function LoadingState({ label, className }: SimpleStateProps) {
  return (
    <StateCard
      icon={<LoaderCircleIcon className="size-4 animate-spin" />}
      title="Loading"
      description={label}
      className={className}
    />
  );
}

export function ErrorState({ label, className }: SimpleStateProps) {
  return (
    <StateCard
      icon={<AlertCircleIcon className="size-4" />}
      title="Something went wrong"
      description={label}
      className={className}
    />
  );
}

export function EmptyState({ label, className }: SimpleStateProps) {
  return <StateCard icon={<InboxIcon className="size-4" />} title="Nothing here yet" description={label} className={className} />;
}
