import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useSearchParams } from "react-router-dom";

import { DataTable } from "@/components/data-table";
import { DetailSheet } from "@/components/detail-sheet";
import { PaginationControls } from "@/components/pagination-controls";
import { EmptyState } from "@/components/states";
import { StatusBadge } from "@/components/status-badge";
import { Timestamp } from "@/components/timestamp";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, queryKeys, type HistoryRecord } from "@/lib/api";
import { repoLabel, truncate } from "@/lib/format";

const PAGE_SIZE = 20;
const parsePage = (value: string | null): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
};

const columnHelper = createColumnHelper<HistoryRecord>();

const repoSummary = (record: HistoryRecord): string => {
  if (record.repos.length === 0) {
    return "-";
  }

  return record.repos.map((repo) => repoLabel(repo.path)).join(", ");
};

export function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") ?? "";
  const repo = searchParams.get("repo") ?? "";
  const stage = searchParams.get("stage") ?? "";
  const page = parsePage(searchParams.get("page"));
  const selectedStepId = searchParams.get("selected");

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

  const historyQueryParams = {
    ...(search ? { search } : {}),
    ...(repo ? { repo } : {}),
    ...(stage ? { stage } : {}),
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  };

  const historyQuery = useQuery({
    queryKey: queryKeys.history(historyQueryParams),
    queryFn: () => api.listHistory(historyQueryParams),
    placeholderData: keepPreviousData,
  });

  const rawHistory = historyQuery.data ?? [];
  const history = rawHistory.slice(0, PAGE_SIZE);
  const hasNext = rawHistory.length > PAGE_SIZE;
  const selectedRecord = rawHistory.find((record) => record.stepId === selectedStepId) ?? null;

  const columns = useMemo(
    () => [
      columnHelper.accessor("createdAt", {
        header: "Created",
        cell: ({ getValue }) => <Timestamp value={getValue()} />,
      }),
      columnHelper.accessor("stage", {
        header: "Stage",
        cell: ({ getValue }) => <StatusBadge value={getValue()} />,
      }),
      columnHelper.accessor("issue", {
        header: "Issue",
        cell: ({ getValue }) => <div className="text-sm text-foreground">{getValue()}</div>,
      }),
      columnHelper.display({
        id: "repos",
        header: "Repos",
        cell: ({ row }) => <div className="text-sm text-muted-foreground">{repoSummary(row.original)}</div>,
      }),
      columnHelper.accessor("summary", {
        header: "Summary",
        cell: ({ getValue }) => <div className="max-w-xl text-sm text-muted-foreground">{truncate(getValue(), 120)}</div>,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: history,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-6">
      <Card className="border border-border/80 bg-card/70 backdrop-blur-sm">
        <CardHeader className="border-b border-border/60">
          <CardTitle>Filters</CardTitle>
          <CardDescription>Search by issue text, repo, or stage. Search state lives in the URL.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4 md:grid-cols-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
          <Input value={search} placeholder="Search issue or summary" onChange={(event) => updateParams({ search: event.target.value || null, page: null }, true)} />
          <Input value={repo} placeholder="Repo path contains" onChange={(event) => updateParams({ repo: event.target.value || null, page: null }, true)} />
          <Input value={stage} placeholder="Stage" onChange={(event) => updateParams({ stage: event.target.value || null, page: null }, true)} />
        </CardContent>
      </Card>

      <DataTable
        table={table}
        isLoading={historyQuery.isPending || historyQuery.isFetching}
        error={historyQuery.isError ? (historyQuery.error instanceof Error ? historyQuery.error.message : "Failed to load history.") : null}
        emptyMessage="No history matches the current filters."
        onRowClick={(record) => updateParams({ selected: record.stepId })}
        tableClassName="min-w-[64rem]"
      />

      <PaginationControls
        page={page}
        hasNext={hasNext}
        disabled={historyQuery.isFetching}
        onPrevious={() => updateParams({ page: page > 0 ? String(page) : null })}
        onNext={() => updateParams({ page: String(page + 2) })}
      />

      <DetailSheet
        open={Boolean(selectedRecord)}
        onOpenChange={(open) => {
          if (!open) {
            updateParams({ selected: null });
          }
        }}
        title={selectedRecord?.issue ?? "History step"}
        description="Snapshot of the durable history entry and the repo transitions captured for it."
      >
        {selectedRecord ? (
          <div className="space-y-4">
            <Card className="border border-border/80">
              <CardHeader className="border-b border-border/60">
                <CardTitle>Step summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-4 text-sm text-muted-foreground">
                <div className="flex items-center justify-between gap-3"><span>Created</span><Timestamp value={selectedRecord.createdAt} /></div>
                <div className="flex items-center justify-between gap-3"><span>Stage</span><StatusBadge value={selectedRecord.stage} /></div>
                <div className="space-y-1"><div>Issue</div><div className="text-foreground">{selectedRecord.issue}</div></div>
                <div className="space-y-1"><div>Summary</div><div className="text-foreground">{selectedRecord.summary}</div></div>
              </CardContent>
            </Card>

            <Card className="border border-border/80">
              <CardHeader className="border-b border-border/60">
                <CardTitle>Repo transitions</CardTitle>
                <CardDescription>Before and after SHAs captured when this history step was recorded.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-4">
                {selectedRecord.repos.length === 0 ? (
                  <EmptyState label="No repo transitions recorded." />
                ) : (
                  selectedRecord.repos.map((repoRecord) => (
                    <div key={`${repoRecord.path}-${repoRecord.position}`} className="border border-border bg-background/60 p-4">
                      <div className="font-mono text-xs text-foreground">{repoRecord.path}</div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div className="space-y-1 text-sm text-muted-foreground">
                          <div>Before</div>
                          <div className="font-mono text-xs text-foreground">{repoRecord.beforeSha}</div>
                        </div>
                        <div className="space-y-1 text-sm text-muted-foreground">
                          <div>After</div>
                          <div className="font-mono text-xs text-foreground">{repoRecord.afterSha}</div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DetailSheet>
    </div>
  );
}
