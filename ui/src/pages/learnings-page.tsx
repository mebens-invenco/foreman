import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createColumnHelper, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { useSearchParams } from "react-router-dom";

import { DataTable } from "@/components/data-table";
import { DetailSheet } from "@/components/detail-sheet";
import { PaginationControls } from "@/components/pagination-controls";
import { StatusBadge } from "@/components/status-badge";
import { Timestamp } from "@/components/timestamp";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, queryKeys, type LearningRecord } from "@/lib/api";

const PAGE_SIZE = 20;
const parsePage = (value: string | null): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
};

const columnHelper = createColumnHelper<LearningRecord>();

export function LearningsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get("search") ?? "";
  const repo = searchParams.get("repo") ?? "";
  const page = parsePage(searchParams.get("page"));
  const selectedLearningId = searchParams.get("selected");

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

  const learningsQueryParams = {
    ...(search ? { search } : {}),
    ...(repo ? { repo } : {}),
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  };

  const learningsQuery = useQuery({
    queryKey: queryKeys.learnings(learningsQueryParams),
    queryFn: () => api.listLearnings(learningsQueryParams),
    placeholderData: keepPreviousData,
  });

  const rawLearnings = learningsQuery.data ?? [];
  const learnings = rawLearnings.slice(0, PAGE_SIZE);
  const hasNext = rawLearnings.length > PAGE_SIZE;
  const selectedLearning = rawLearnings.find((learning) => learning.id === selectedLearningId) ?? null;

  const columns = useMemo(
    () => [
      columnHelper.accessor("title", {
        header: "Title",
        cell: ({ getValue }) => <div className="text-sm text-foreground">{getValue()}</div>,
      }),
      columnHelper.accessor("repo", {
        header: "Repo",
        cell: ({ getValue }) => <div className="text-sm text-muted-foreground">{getValue()}</div>,
      }),
      columnHelper.accessor("confidence", {
        header: "Confidence",
        cell: ({ getValue }) => <StatusBadge value={getValue()} />,
      }),
      columnHelper.accessor("readCount", {
        header: "Read",
        cell: ({ getValue }) => <div className="font-mono text-xs text-muted-foreground">{getValue()}</div>,
      }),
      columnHelper.accessor("appliedCount", {
        header: "Applied",
        cell: ({ getValue }) => <div className="font-mono text-xs text-muted-foreground">{getValue()}</div>,
      }),
      columnHelper.accessor("updatedAt", {
        header: "Updated",
        cell: ({ getValue }) => <Timestamp value={getValue()} />,
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: learnings,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-6">
      <Card className="border border-border/80 bg-card/70 backdrop-blur-sm">
        <CardHeader className="border-b border-border/60">
          <CardTitle>Filters</CardTitle>
          <CardDescription>Search learnings by title, content, or repo and keep detail state shareable.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Input value={search} placeholder="Search title or content" onChange={(event) => updateParams({ search: event.target.value || null, page: null }, true)} />
          <Input value={repo} placeholder="Repo" onChange={(event) => updateParams({ repo: event.target.value || null, page: null }, true)} />
        </CardContent>
      </Card>

      <DataTable
        table={table}
        isLoading={learningsQuery.isPending || learningsQuery.isFetching}
        error={learningsQuery.isError ? (learningsQuery.error instanceof Error ? learningsQuery.error.message : "Failed to load learnings.") : null}
        emptyMessage="No learnings match the current filters."
        onRowClick={(learning) => updateParams({ selected: learning.id })}
      />

      <PaginationControls
        page={page}
        hasNext={hasNext}
        disabled={learningsQuery.isFetching}
        onPrevious={() => updateParams({ page: page > 0 ? String(page) : null })}
        onNext={() => updateParams({ page: String(page + 2) })}
      />

      <DetailSheet
        open={Boolean(selectedLearning)}
        onOpenChange={(open) => {
          if (!open) {
            updateParams({ selected: null });
          }
        }}
        title={selectedLearning?.title ?? "Learning"}
        description="Reusable repo guidance with confidence, metadata, and the original content." 
      >
        {selectedLearning ? (
          <div className="space-y-4">
            <Card className="border border-border/80">
              <CardHeader className="border-b border-border/60">
                <CardTitle>Metadata</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 pt-4 md:grid-cols-2">
                <div className="space-y-3 text-sm text-muted-foreground">
                  <div className="flex items-center justify-between gap-3"><span>Repo</span><span className="text-foreground">{selectedLearning.repo}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>Confidence</span><StatusBadge value={selectedLearning.confidence} /></div>
                  <div className="flex items-center justify-between gap-3"><span>Updated</span><Timestamp value={selectedLearning.updatedAt} /></div>
                </div>
                <div className="space-y-3 text-sm text-muted-foreground">
                  <div className="flex items-center justify-between gap-3"><span>Applied</span><span className="text-foreground">{selectedLearning.appliedCount}</span></div>
                  <div className="flex items-center justify-between gap-3"><span>Read</span><span className="text-foreground">{selectedLearning.readCount}</span></div>
                  <div className="space-y-1"><div>Tags</div><div className="text-foreground">{selectedLearning.tags.length > 0 ? selectedLearning.tags.join(", ") : "-"}</div></div>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-border/80">
              <CardHeader className="border-b border-border/60">
                <CardTitle>Content</CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <pre className="overflow-x-auto border border-border bg-background p-4 font-mono text-xs leading-6 text-foreground whitespace-pre-wrap">
                  {selectedLearning.content}
                </pre>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DetailSheet>
    </div>
  );
}
