<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { derived, writable } from "svelte/store";

  import { api, type LearningRecord } from "../lib/api";
  import Card from "../lib/components/Card.svelte";
  import DataTable from "../lib/components/DataTable.svelte";
  import Drawer from "../lib/components/Drawer.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import ErrorState from "../lib/components/ErrorState.svelte";
  import Input from "../lib/components/Input.svelte";
  import LoadingState from "../lib/components/LoadingState.svelte";
  import Pagination from "../lib/components/Pagination.svelte";
  import StatusPill from "../lib/components/StatusPill.svelte";
  import Timestamp from "../lib/components/Timestamp.svelte";

  const pageSize = 20;

  const search = writable("");
  const repo = writable("");
  const page = writable(0);
  const selectedLearningId = writable<string | null>(null);
  let learnings: LearningRecord[] = [];
  let hasNext = false;
  let learningFilterKey = "";

  const learningsQuery = createQuery(
    derived([search, repo, page], ([$search, $repo, $page]) => ({
      queryKey: ["learnings", $search, $repo, $page],
      queryFn: () => api.listLearnings({ search: $search || undefined, repo: $repo || undefined, limit: pageSize + 1, offset: $page * pageSize }),
    })),
  );

  $: rawLearnings = ($learningsQuery.data ?? []) as LearningRecord[];
  $: learnings = rawLearnings.slice(0, pageSize);
  $: hasNext = rawLearnings.length > pageSize;
  $: {
    const nextFilterKey = `${$search}|${$repo}`;
    if (nextFilterKey !== learningFilterKey) {
      learningFilterKey = nextFilterKey;
      $page = 0;
    }
  }
  $: selectedLearning = learnings.find((item) => item.id === $selectedLearningId) ?? rawLearnings.find((item) => item.id === $selectedLearningId) ?? null;
</script>

<div class="space-y-6">
  <Card title="Filters" subtitle="Search learnings by content and repo.">
    <div class="grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Input bind:value={$search} placeholder="Search title or content" />
      <Input bind:value={$repo} placeholder="Repo" />
    </div>
  </Card>

  {#if $learningsQuery.isError}
    <ErrorState message={$learningsQuery.error instanceof Error ? $learningsQuery.error.message : "Failed to load learnings."} />
  {:else if $learningsQuery.isPending}
    <LoadingState label="Loading learnings..." />
  {:else if learnings.length === 0}
    <EmptyState label="No learnings match the current filters." />
  {:else}
    <div class="space-y-4">
      <DataTable>
        <thead class="bg-muted/40 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <tr>
            <th class="px-3 py-2">Title</th>
            <th class="px-3 py-2">Repo</th>
            <th class="px-3 py-2">Confidence</th>
            <th class="px-3 py-2">Updated</th>
          </tr>
        </thead>
        <tbody>
          {#each learnings as learning}
            <tr class="cursor-pointer border-t border-border hover:bg-muted/40" on:click={() => ($selectedLearningId = learning.id)}>
              <td class="px-3 py-3 text-sm text-foreground">{learning.title}</td>
              <td class="px-3 py-3 text-sm text-muted-foreground">{learning.repo}</td>
              <td class="px-3 py-3"><StatusPill value={learning.confidence} /></td>
              <td class="px-3 py-3"><Timestamp value={learning.updatedAt} /></td>
            </tr>
          {/each}
        </tbody>
      </DataTable>

      <Pagination page={$page} {hasNext} disabled={$learningsQuery.isFetching} onPrevious={() => page.update((value) => Math.max(0, value - 1))} onNext={() => page.update((value) => value + 1)} />
    </div>
  {/if}
</div>

<Drawer open={selectedLearning !== null} title={selectedLearning?.title ?? "Learning"} onClose={() => ($selectedLearningId = null)}>
  {#if selectedLearning}
    <div class="space-y-4">
      <Card title="Metadata">
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2 text-sm text-muted-foreground">
            <div><span class="text-foreground">Repo:</span> {selectedLearning.repo}</div>
            <div><span class="text-foreground">Confidence:</span> <StatusPill value={selectedLearning.confidence} /></div>
            <div><span class="text-foreground">Updated:</span> <Timestamp value={selectedLearning.updatedAt} /></div>
          </div>
          <div class="space-y-2 text-sm text-muted-foreground">
            <div><span class="text-foreground">Applied:</span> {selectedLearning.appliedCount}</div>
            <div><span class="text-foreground">Read:</span> {selectedLearning.readCount}</div>
            <div><span class="text-foreground">Tags:</span> {selectedLearning.tags.length > 0 ? selectedLearning.tags.join(", ") : "-"}</div>
          </div>
        </div>
      </Card>

      <Card title="Content">
        <pre class="m-0 whitespace-pre-wrap bg-background p-4 font-mono text-xs leading-6 text-foreground">{selectedLearning.content}</pre>
      </Card>
    </div>
  {/if}
</Drawer>
