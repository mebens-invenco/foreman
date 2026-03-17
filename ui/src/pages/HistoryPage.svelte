<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { derived, writable } from "svelte/store";

  import { api, type HistoryRecord } from "../lib/api";
  import Card from "../lib/components/Card.svelte";
  import DataTable from "../lib/components/DataTable.svelte";
  import Drawer from "../lib/components/Drawer.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import ErrorState from "../lib/components/ErrorState.svelte";
  import Input from "../lib/components/Input.svelte";
  import LoadingState from "../lib/components/LoadingState.svelte";
  import Pagination from "../lib/components/Pagination.svelte";
  import Timestamp from "../lib/components/Timestamp.svelte";

  const pageSize = 20;

  const search = writable("");
  const repo = writable("");
  const stage = writable("");
  const page = writable(0);
  const selectedStepId = writable<string | null>(null);
  let history: HistoryRecord[] = [];
  let hasNext = false;
  let historyFilterKey = "";

  const repoNames = (record: HistoryRecord): string => {
    if (record.repos.length === 0) {
      return "-";
    }

    return record.repos
      .map((repoRecord) => repoRecord.path.split("/").filter(Boolean).pop() ?? repoRecord.path)
      .join(", ");
  };

  const historyQuery = createQuery(
    derived([search, repo, stage, page], ([$search, $repo, $stage, $page]) => ({
      queryKey: ["history", $search, $repo, $stage, $page],
      queryFn: () =>
        api.listHistory({
          search: $search || undefined,
          repo: $repo || undefined,
          stage: $stage || undefined,
          limit: pageSize + 1,
          offset: $page * pageSize,
        }),
    })),
  );

  $: rawHistory = ($historyQuery.data ?? []) as HistoryRecord[];
  $: history = rawHistory.slice(0, pageSize);
  $: hasNext = rawHistory.length > pageSize;
  $: {
    const nextFilterKey = `${$search}|${$repo}|${$stage}`;
    if (nextFilterKey !== historyFilterKey) {
      historyFilterKey = nextFilterKey;
      $page = 0;
    }
  }
  $: selectedRecord = history.find((record) => record.stepId === $selectedStepId) ?? rawHistory.find((record) => record.stepId === $selectedStepId) ?? null;
</script>

<div class="space-y-6">
  <Card title="Filters" subtitle="Search by issue text, repo path, or stage.">
    <div class="grid gap-3 md:grid-cols-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
      <Input bind:value={$search} placeholder="Search issue or summary" />
      <Input bind:value={$repo} placeholder="Repo path contains" />
      <Input bind:value={$stage} placeholder="Stage" />
    </div>
  </Card>

  {#if $historyQuery.isError}
    <ErrorState message={$historyQuery.error instanceof Error ? $historyQuery.error.message : "Failed to load history."} />
  {:else if $historyQuery.isPending}
    <LoadingState label="Loading history..." />
  {:else if history.length === 0}
    <EmptyState label="No history matches the current filters." />
  {:else}
    <div class="space-y-4">
      <DataTable>
        <thead class="bg-muted/40 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <tr>
            <th class="px-3 py-2">Created</th>
            <th class="px-3 py-2">Stage</th>
            <th class="px-3 py-2">Issue</th>
            <th class="px-3 py-2">Repos</th>
          </tr>
        </thead>
        <tbody>
          {#each history as record}
            <tr class="cursor-pointer border-t border-border hover:bg-muted/40" on:click={() => ($selectedStepId = record.stepId)}>
              <td class="px-3 py-3"><Timestamp value={record.createdAt} /></td>
              <td class="px-3 py-3 text-sm text-foreground">{record.stage}</td>
              <td class="px-3 py-3 text-sm text-foreground">{record.issue}</td>
              <td class="px-3 py-3 text-sm text-muted-foreground">{repoNames(record)}</td>
            </tr>
          {/each}
        </tbody>
      </DataTable>

      <Pagination page={$page} {hasNext} disabled={$historyQuery.isFetching} onPrevious={() => page.update((value) => Math.max(0, value - 1))} onNext={() => page.update((value) => value + 1)} />
    </div>
  {/if}
</div>

<Drawer open={selectedRecord !== null} title={selectedRecord?.issue ?? "History Step"} onClose={() => ($selectedStepId = null)}>
  {#if selectedRecord}
    <div class="space-y-4">
      <Card title="Step Summary">
        <div class="space-y-2 text-sm text-muted-foreground">
          <div><span class="text-foreground">Created:</span> <Timestamp value={selectedRecord.createdAt} /></div>
          <div><span class="text-foreground">Stage:</span> {selectedRecord.stage}</div>
          <div><span class="text-foreground">Issue:</span> {selectedRecord.issue}</div>
        </div>
        <div class="mt-4 text-sm text-foreground">{selectedRecord.summary}</div>
      </Card>

      <Card title="Repo Transitions" subtitle="Before and after SHAs captured for this history step.">
        {#if selectedRecord.repos.length === 0}
          <EmptyState label="No repo transitions recorded." />
        {:else}
          <div class="space-y-3">
            {#each selectedRecord.repos as repoRecord}
              <div class="panel-surface p-4">
                <div class="font-mono text-xs text-foreground">{repoRecord.path}</div>
                <div class="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                  <div>Before: <span class="font-mono text-xs">{repoRecord.beforeSha}</span></div>
                  <div>After: <span class="font-mono text-xs">{repoRecord.afterSha}</span></div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </Card>
    </div>
  {/if}
</Drawer>
