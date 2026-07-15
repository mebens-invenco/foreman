import { useSearchParams } from "react-router"

import {
  DataTable,
  DataTableFilterSelect,
  DataTablePagination,
  DataTableShell,
  DataTableToolbar,
  useDataTable,
} from "@/components/data-table"
import { Sheet } from "@/components/ui/sheet"
import {
  useLearningsQuery,
  useSetLearningArchivedMutation,
} from "@/hooks/use-learnings-query"
import {
  getLearningRepoOptions,
  learningColumns,
  learningConfidenceOptions,
  learningsGlobalFilter,
  learningStatusOptions,
  matchesLearningStatus,
} from "@/pages/learnings/columns"
import { LearningDetailSheet } from "@/pages/learnings/learning-detail-sheet"
import { useLearningsTableState } from "@/pages/learnings/use-learnings-table-state"

export function LearningsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedLearningId = searchParams.get("learningId")
  const { data: learnings = [], isLoading, isError, error } = useLearningsQuery()
  const tableState = useLearningsTableState()
  const archiveMutation = useSetLearningArchivedMutation()
  // The lifecycle toggle narrows the data itself (no status column to filter on);
  // repo options still derive from the full list so every repo stays selectable.
  const visibleLearnings = learnings.filter((learning) =>
    matchesLearningStatus(learning, tableState.status)
  )
  const table = useDataTable({
    columns: learningColumns,
    columnFilters: tableState.columnFilters,
    data: visibleLearnings,
    getRowId: (row) => row.id,
    globalFilter: tableState.globalFilter,
    globalFilterFn: learningsGlobalFilter,
    onGlobalFilterChange: tableState.setGlobalFilter,
    onPaginationChange: tableState.setPagination,
    onSortingChange: tableState.setSorting,
    pagination: tableState.pagination,
    sorting: tableState.sorting,
  })
  const repoOptions = getLearningRepoOptions(learnings)
  const selectedLearning =
    learnings.find((learning) => learning.id === selectedLearningId) ?? null

  const setSelectedLearningId = (learningId: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (learningId) {
      next.set("learningId", learningId)
    } else {
      next.delete("learningId")
    }
    setSearchParams(next, { replace: true })
  }

  return (
    <>
      <div className="space-y-4">
        <header>
          <h2 className="text-3xl tracking-tight text-foreground">Captured learnings</h2>
        </header>

        <DataTableShell>
          <DataTableToolbar
            hasActiveFilters={tableState.hasActiveFilters}
            onReset={tableState.resetFilters}
            onSearchChange={tableState.setGlobalFilter}
            searchPlaceholder="Search learnings by title, repo, tags, and content"
            searchValue={tableState.globalFilter}
          >
            <DataTableFilterSelect
              allLabel="All confidence"
              label="Confidence"
              onValueChange={tableState.setConfidence}
              options={learningConfidenceOptions}
              value={tableState.confidence}
            />
            <DataTableFilterSelect
              allLabel="All repos"
              label="Repo"
              onValueChange={tableState.setRepo}
              options={repoOptions}
              value={tableState.repo}
            />
            <DataTableFilterSelect
              allLabel="All statuses"
              label="Status"
              onValueChange={tableState.setStatus}
              options={learningStatusOptions}
              value={tableState.status}
            />
          </DataTableToolbar>

          <DataTable
            emptyMessage={
              learnings.length === 0
                ? "No learnings have been captured yet."
                : "No learnings match the current filters."
            }
            error={error}
            isError={isError}
            isLoading={isLoading}
            onRowClick={(learning) => setSelectedLearningId(learning.id)}
            table={table}
          />

          <DataTablePagination table={table} />
        </DataTableShell>
      </div>

      <Sheet
        open={selectedLearningId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedLearningId(null)
          }
        }}
      >
        <LearningDetailSheet
          learning={selectedLearning}
          onSelectLearning={setSelectedLearningId}
          onSetArchived={(id, archived) =>
            archiveMutation.mutate({ id, archived })
          }
          isUpdatingArchive={archiveMutation.isPending}
        />
      </Sheet>
    </>
  )
}
