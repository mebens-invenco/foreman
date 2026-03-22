import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type MetricCardProps = {
  eyebrow: string;
  value: string;
  detail: string;
  icon?: ReactNode;
  className?: string;
};

export function MetricCard({ eyebrow, value, detail, icon, className }: MetricCardProps) {
  return (
    <Card className={cn("border border-border/80 bg-card/70 backdrop-blur-sm", className)}>
      <CardHeader className="border-b border-border/60 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</div>
            <CardTitle className="mt-3 text-3xl leading-none tracking-tight text-foreground">{value}</CardTitle>
          </div>
          {icon ? <div className="text-muted-foreground">{icon}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}
