import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PauseIcon, PlayIcon, ScanSearchIcon, SquareIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { api, queryKeys, type SchedulerAction, type SchedulerStatus } from "@/lib/api";

type SchedulerControlsProps = {
  status: SchedulerStatus | undefined;
};

export function SchedulerControls({ status }: SchedulerControlsProps) {
  const queryClient = useQueryClient();

  const refreshShellQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.status }),
      queryClient.invalidateQueries({ queryKey: queryKeys.workers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.queue }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      queryClient.invalidateQueries({ queryKey: ["history"] }),
    ]);
  };

  const schedulerMutation = useMutation({
    mutationFn: (action: SchedulerAction) => api.postSchedulerAction(action),
    onSuccess: async (_, action) => {
      toast.success(`Scheduler ${action} request sent.`);
      await refreshShellQueries();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Scheduler action failed.");
    },
  });

  const scoutMutation = useMutation({
    mutationFn: () => api.runScout(),
    onSuccess: async () => {
      toast.success("Scout run scheduled.");
      await refreshShellQueries();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to run scout.");
    },
  });

  const busy = schedulerMutation.isPending || scoutMutation.isPending;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {status ? <StatusBadge value={status} className="hidden sm:inline-flex" /> : null}
      <Button
        type="button"
        size="sm"
        variant={status === "running" ? "default" : "outline"}
        disabled={busy || status === "running"}
        onClick={() => schedulerMutation.mutate("start")}
      >
        <PlayIcon className="size-4" />
        Start
      </Button>
      <Button
        type="button"
        size="sm"
        variant={status === "paused" ? "default" : "outline"}
        disabled={busy || status === "paused"}
        onClick={() => schedulerMutation.mutate("pause")}
      >
        <PauseIcon className="size-4" />
        Pause
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={busy || status === "stopping"} onClick={() => schedulerMutation.mutate("stop")}>
        <SquareIcon className="size-4" />
        Stop
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => scoutMutation.mutate()}>
        <ScanSearchIcon className="size-4" />
        Run Scout
      </Button>
    </div>
  );
}
