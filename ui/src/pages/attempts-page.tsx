import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { BoxIcon, FileTextIcon, ListTreeIcon, ScrollTextIcon } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { DataTable } from "@/components/data-table";
import { DetailSheet } from "@/components/detail-sheet";
import { PaginationControls } from "@/components/pagination-controls";
import { ErrorState, EmptyState } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { StreamLogPanel } from "@/components/stream-log-panel";
import { Timestamp } from "@/components/timestamp";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  queryKeys,
  type Attempt,
  type AttemptEvent,
  type AttemptStatus,
} from "@/lib/api";
import { formatDuration, truncateMiddle } from "@/lib/format";

const PAGE_SIZE = 20;
const statusOptions = ["all", "running", "completed", "failed", "blocked", "canceled", "timed_out"] as const;
const detailTabs = [
  { value: "summary", label: "Summary", icon: FileTextIcon },
  { value: "events", label: "Events", icon: ListTreeIcon },
  { value: "logs", label: "Logs", icon: ScrollTextIcon },
  { value: "artifacts", label: "Artifacts", icon: BoxIcon },
] as const;

type AttemptFilterStatus = (typeof statusOptions)[number];
type AttemptDetailTab = (typeof detailTabs)[number]["value"];

const parsePage = (value: string | null): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
};

const columnHelper = createColumnHelper<Attempt>();

const eventHasPayload = (event: AttemptEvent): boolean => Object.keys(event.payload).length > 0;

export function AttemptsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const page = parsePage(searchParams.get("page"));
  const jobId = searchParams.get("jobId") ?? "";
  const selectedAttemptId = searchParams.get("selected");
  const selectedTab = (searchParams.get("tab") as AttemptDetailTab | null) ?? "summary";
  const statusParam = searchParams.get("status");
  const status = statusOptions.includes(statusParam as AttemptFilterStatus) ? (statusParam as AttemptFilterStatus) : "all";

  const updateParams = (updates: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (!value) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    setSearchParams(next, { replace });
  };

  const attemptQueryParams = {
    ...(status !== "all" ? { status: status as AttemptStatus } : {}),
    ...(jobId ? { jobId } : {}),
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  };

  const attemptsQuery = useQuery({
    queryKey: queryKeys.attempts(attemptQueryParams),
    queryFn: () => api.listAttempts(attemptQueryParams),
    placeholderData: keepPreviousData,
  });

  const attemptDetailQuery = useQuery({
    queryKey: queryKeys.attempt(selectedAttemptId),
    enabled: Boolean(selectedAttemptId),
    queryFn: () => api.getAttempt(selectedAttemptId!),
    refetchInterval: selectedAttemptId ? 5000 : false,
  });

  const rawAttempts = attemptsQuery.data ?? [];
  const attempts = rawAttempts.slice(0, PAGE_SIZE);
  const hasNext = rawAttempts.length > PAGE_SIZE;

  const columns = useMemo(
    () => [
      columnHelper.accessor("id", {
        header: "Attempt",
        cell: ({ row, getValue }) => (
          <div className="space-y-1">
            <div className="font-mono text-xs text-foreground">{truncateMiddle(getValue(), 10)}</div>
            <div className="text-xs text-muted-foreground">Attempt #{row.original.attemptNumber}</div>
          </div>
        ),
      }),
      columnHelper.accessor("jobId", {
        header: "Job",
        cell: ({ getValue }) => <div className="font-mono text-xs text-muted-foreground">{truncateMiddle(getValue(), 12)}</div>,
      }),
      columnHelper.accessor("workerId", {
        header: "Worker",
        cell: ({ getValue }) => <div className="text-sm text-muted-foreground">{getValue() ?? "-"}</div>,
      }),
      columnHelper.accessor("status", {
        header: "Status",
        cell: ({ getValue }) => <StatusBadge value={getValue()} />,
      }),
      columnHelper.accessor("startedAt", {
        header: "Started",
        cell: ({ getValue }) => <Timestamp value={getValue()} />,
      }),
      columnHelper.display({
        id: "duration",
        header: "Duration",
        cell: ({ row }) => <div className="text-sm text-muted-foreground">{formatDuration(row.original.startedAt, row.original.finishedAt)}</div>,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: attempts,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-6">
      <Card className="border border-border/80 bg-card/70 backdrop-blur-sm">
        <CardHeader className="border-b border-border/60">
          <CardTitle>Filters</CardTitle>
          <CardDescription>Recent attempts with URL-backed filters, pagination, and detail tabs.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4 md:grid-cols-[12rem_minmax(0,1fr)]">
          <Select
            value={status}
            onValueChange={(value) => {
              updateParams({ status: value === "all" ? null : value, page: null }, true);
            }}
          >
            <SelectTrigger className="w-full bg-background/70">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {statusOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {option.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={jobId}
            placeholder="Filter by job id"
            onChange={(event) => {
              const value = event.target.value;
              updateParams({ jobId: value || null, page: null }, true);
            }}
          />
        </CardContent>
      </Card>

      <DataTable
        table={table}
        isLoading={attemptsQuery.isPending || attemptsQuery.isFetching}
        error={attemptsQuery.isError ? (attemptsQuery.error instanceof Error ? attemptsQuery.error.message : "Failed to load attempts.") : null}
        emptyMessage="No attempts match the current filters."
        onRowClick={(attempt) => updateParams({ selected: attempt.id, tab: "summary" })}
      />

      <PaginationControls
        page={page}
        hasNext={hasNext}
        disabled={attemptsQuery.isFetching}
        onPrevious={() => updateParams({ page: page > 0 ? String(page) : null })}
        onNext={() => updateParams({ page: String(page + 2) })}
      />

      <DetailSheet
        open={Boolean(selectedAttemptId)}
        onOpenChange={(open) => {
          if (!open) {
            updateParams({ selected: null, tab: null });
          }
        }}
        title={selectedAttemptId ?? "Attempt"}
        description="Execution detail, structured events, live logs, and collected artifacts."
      >
        {attemptDetailQuery.isPending ? (
          <div className="space-y-4">
            <Card><CardContent className="pt-4 text-sm text-muted-foreground">Loading attempt detail...</CardContent></Card>
          </div>
        ) : attemptDetailQuery.isError ? (
          <ErrorState label={attemptDetailQuery.error instanceof Error ? attemptDetailQuery.error.message : "Failed to load attempt detail."} />
        ) : attemptDetailQuery.data ? (
          <Tabs
            value={selectedTab}
            onValueChange={(value) => updateParams({ tab: value as AttemptDetailTab })}
          >
            <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b border-border/70 pb-2">
              {detailTabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger key={tab.value} value={tab.value} className="gap-2 data-active:text-foreground">
                    <Icon className="size-4" />
                    {tab.label}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <TabsContent value="summary" className="mt-6 space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="border border-border/80">
                  <CardHeader className="border-b border-border/60">
                    <CardTitle>Attempt summary</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-4 text-sm text-muted-foreground">
                    <div className="flex items-center justify-between gap-3"><span>Status</span><StatusBadge value={attemptDetailQuery.data.attempt.status} /></div>
                    <div className="flex items-center justify-between gap-3"><span>Job</span><span className="font-mono text-xs text-foreground">{attemptDetailQuery.data.attempt.jobId}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Worker</span><span className="text-foreground">{attemptDetailQuery.data.attempt.workerId ?? "-"}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Runner</span><span className="text-foreground">{attemptDetailQuery.data.attempt.runnerModel} / {attemptDetailQuery.data.attempt.runnerVariant}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Duration</span><span className="text-foreground">{formatDuration(attemptDetailQuery.data.attempt.startedAt, attemptDetailQuery.data.attempt.finishedAt)}</span></div>
                  </CardContent>
                </Card>
                <Card className="border border-border/80">
                  <CardHeader className="border-b border-border/60">
                    <CardTitle>Outcome</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-4 text-sm text-muted-foreground">
                    <div className="flex items-center justify-between gap-3"><span>Exit code</span><span className="text-foreground">{attemptDetailQuery.data.attempt.exitCode ?? "-"}</span></div>
                    <div className="flex items-center justify-between gap-3"><span>Signal</span><span className="text-foreground">{attemptDetailQuery.data.attempt.signal ?? "-"}</span></div>
                    <div className="space-y-1"><div>Summary</div><div className="text-foreground">{attemptDetailQuery.data.attempt.summary || "No summary recorded."}</div></div>
                    <div className="space-y-1"><div>Error</div><div className="text-foreground">{attemptDetailQuery.data.attempt.errorMessage ?? "-"}</div></div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
            <TabsContent value="events" className="mt-6 space-y-3">
              {attemptDetailQuery.data.events.length === 0 ? (
                <EmptyState label="No events recorded for this attempt." />
              ) : (
                attemptDetailQuery.data.events.map((event) => (
                  <Card key={event.id} className="border border-border/80">
                    <CardHeader className="border-b border-border/60">
                      <div className="flex items-center justify-between gap-4">
                        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{event.eventType}</div>
                        <Timestamp value={event.createdAt} />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3 pt-4">
                      <div className="text-sm text-foreground">{event.message}</div>
                      {eventHasPayload(event) ? (
                        <pre className="overflow-x-auto border border-border bg-background p-3 font-mono text-xs text-muted-foreground">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      ) : null}
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>
            <TabsContent value="logs" className="mt-6">
              <StreamLogPanel
                streamUrl={selectedAttemptId ? `/api/attempts/${selectedAttemptId}/logs/stream` : null}
                initialUrl={selectedAttemptId ? `/api/attempts/${selectedAttemptId}/logs` : null}
                emptyMessage="This attempt has not produced logs yet."
              />
            </TabsContent>
            <TabsContent value="artifacts" className="mt-6 space-y-3">
              {attemptDetailQuery.data.artifacts.length === 0 ? (
                <EmptyState label="No artifacts attached to this attempt." />
              ) : (
                attemptDetailQuery.data.artifacts.map((artifact) => (
                  <Card key={artifact.id} className="border border-border/80">
                    <CardHeader className="border-b border-border/60">
                      <div className="flex items-center justify-between gap-4">
                        <CardTitle className="text-sm">{artifact.artifactType}</CardTitle>
                        <Timestamp value={artifact.createdAt} />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2 pt-4 text-sm text-muted-foreground">
                      <div className="text-foreground">{artifact.relativePath}</div>
                      <div>{artifact.mediaType} · {artifact.sizeBytes} bytes</div>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>
          </Tabs>
        ) : null}
      </DetailSheet>
    </div>
  );
}
