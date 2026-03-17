<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { derived, writable } from "svelte/store";

  import { api, type Attempt, type AttemptStatus } from "../lib/api";
  import { formatDuration } from "../lib/format";
  import Card from "../lib/components/Card.svelte";
  import DataTable from "../lib/components/DataTable.svelte";
  import Drawer from "../lib/components/Drawer.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import ErrorState from "../lib/components/ErrorState.svelte";
  import Input from "../lib/components/Input.svelte";
  import LoadingState from "../lib/components/LoadingState.svelte";
  import Pagination from "../lib/components/Pagination.svelte";
  import Select from "../lib/components/Select.svelte";
  import StatusPill from "../lib/components/StatusPill.svelte";
  import StreamLogPanel from "../lib/components/StreamLogPanel.svelte";
  import Tabs from "../lib/components/Tabs.svelte";
  import Timestamp from "../lib/components/Timestamp.svelte";

  const pageSize = 20;
  const statusOptions = ["all", "running", "completed", "failed", "blocked", "canceled", "timed_out"] as const;

  const status = writable<(typeof statusOptions)[number]>("all");
  const jobId = writable("");
  const page = writable(0);
  const selectedAttemptId = writable<string | null>(null);
  let selectedTab = "summary";
  let attempts: Attempt[] = [];
  let hasNext = false;
  let attemptFilterKey = "";

  const attemptsQuery = createQuery(derived([status, jobId, page], ([$status, $jobId, $page]) => ({
    queryKey: ["attempts", $status, $jobId, $page],
    queryFn: () =>
      api.listAttempts({
        status: $status === "all" ? undefined : ($status as AttemptStatus),
        jobId: $jobId || undefined,
        limit: pageSize + 1,
        offset: $page * pageSize,
      }),
  })));

  const attemptDetailQuery = createQuery(
    derived(selectedAttemptId, ($selectedAttemptId) => ({
      queryKey: ["attempt", $selectedAttemptId],
      enabled: Boolean($selectedAttemptId),
      queryFn: () => api.getAttempt($selectedAttemptId!),
    })),
  );

  $: result = ($attemptsQuery.data ?? []) as Attempt[];
  $: attempts = result.slice(0, pageSize);
  $: hasNext = result.length > pageSize;
  $: {
    const nextFilterKey = `${$status}|${$jobId}`;
    if (nextFilterKey !== attemptFilterKey) {
      attemptFilterKey = nextFilterKey;
      $page = 0;
    }
  }

  const openAttempt = (attemptId: string): void => {
    $selectedAttemptId = attemptId;
    selectedTab = "summary";
  };

  const handleTabChange = (value: string): void => {
    selectedTab = value;
  };
</script>

<div class="space-y-6">
  <Card title="Filters" subtitle="Browse recent attempts and drill into execution detail.">
    <div class="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
      <Select bind:value={$status}>
        {#each statusOptions as option}
          <option value={option}>{option}</option>
        {/each}
      </Select>
      <Input bind:value={$jobId} placeholder="Filter by job id" />
    </div>
  </Card>

  {#if $attemptsQuery.isError}
    <ErrorState message={$attemptsQuery.error instanceof Error ? $attemptsQuery.error.message : "Failed to load attempts."} />
  {:else if $attemptsQuery.isPending}
    <LoadingState label="Loading attempts..." />
  {:else if attempts.length === 0}
    <EmptyState label="No attempts match the current filters." />
  {:else}
    <div class="space-y-4">
      <DataTable>
        <thead class="bg-muted/40 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          <tr>
            <th class="px-3 py-2">Attempt</th>
            <th class="px-3 py-2">Job</th>
            <th class="px-3 py-2">Worker</th>
            <th class="px-3 py-2">Status</th>
            <th class="px-3 py-2">Started</th>
            <th class="px-3 py-2">Duration</th>
          </tr>
        </thead>
        <tbody>
          {#each attempts as attempt}
            <tr class="cursor-pointer border-t border-border hover:bg-muted/40" on:click={() => openAttempt(attempt.id)}>
              <td class="px-3 py-3 font-mono text-xs text-foreground">{attempt.id}</td>
              <td class="px-3 py-3 font-mono text-xs text-muted-foreground">{attempt.jobId}</td>
              <td class="px-3 py-3 text-sm text-muted-foreground">{attempt.workerId ?? "-"}</td>
              <td class="px-3 py-3"><StatusPill value={attempt.status} /></td>
              <td class="px-3 py-3"><Timestamp value={attempt.startedAt} /></td>
              <td class="px-3 py-3 text-sm text-muted-foreground">{formatDuration(attempt.startedAt, attempt.finishedAt)}</td>
            </tr>
          {/each}
        </tbody>
      </DataTable>

      <Pagination page={$page} {hasNext} disabled={$attemptsQuery.isFetching} onPrevious={() => page.update((value) => Math.max(0, value - 1))} onNext={() => page.update((value) => value + 1)} />
    </div>
  {/if}
</div>

<Drawer open={$selectedAttemptId !== null} title={$selectedAttemptId ?? "Attempt"} onClose={() => ($selectedAttemptId = null)}>
  {#if $attemptDetailQuery.isPending}
    <LoadingState label="Loading attempt detail..." />
  {:else if $attemptDetailQuery.isError}
    <ErrorState message={$attemptDetailQuery.error instanceof Error ? $attemptDetailQuery.error.message : "Failed to load attempt detail."} />
  {:else if $attemptDetailQuery.data}
    <div class="space-y-4">
      <Tabs
        tabs={[
          { value: "summary", label: "Summary" },
          { value: "events", label: "Events" },
          { value: "logs", label: "Logs" },
          { value: "artifacts", label: "Artifacts" },
        ]}
        value={selectedTab}
        onChange={handleTabChange}
      />

      {#if selectedTab === "summary"}
        <div class="grid gap-4 md:grid-cols-2">
          <Card title="Attempt Summary">
            <div class="space-y-2 text-sm text-muted-foreground">
              <div><span class="text-foreground">Status:</span> <StatusPill value={$attemptDetailQuery.data.attempt.status} /></div>
              <div><span class="text-foreground">Job:</span> <span class="font-mono text-xs">{$attemptDetailQuery.data.attempt.jobId}</span></div>
              <div><span class="text-foreground">Worker:</span> {$attemptDetailQuery.data.attempt.workerId ?? "-"}</div>
              <div><span class="text-foreground">Runner:</span> {$attemptDetailQuery.data.attempt.runnerModel} / {$attemptDetailQuery.data.attempt.runnerVariant}</div>
              <div><span class="text-foreground">Duration:</span> {formatDuration($attemptDetailQuery.data.attempt.startedAt, $attemptDetailQuery.data.attempt.finishedAt)}</div>
            </div>
          </Card>

          <Card title="Outcome">
            <div class="space-y-2 text-sm text-muted-foreground">
              <div><span class="text-foreground">Exit code:</span> {$attemptDetailQuery.data.attempt.exitCode ?? "-"}</div>
              <div><span class="text-foreground">Signal:</span> {$attemptDetailQuery.data.attempt.signal ?? "-"}</div>
              <div><span class="text-foreground">Summary:</span> {$attemptDetailQuery.data.attempt.summary || "No summary recorded."}</div>
              <div><span class="text-foreground">Error:</span> {$attemptDetailQuery.data.attempt.errorMessage ?? "-"}</div>
            </div>
          </Card>
        </div>
      {:else if selectedTab === "events"}
        {#if $attemptDetailQuery.data.events.length === 0}
          <EmptyState label="No events recorded for this attempt." />
        {:else}
          <div class="space-y-3">
            {#each $attemptDetailQuery.data.events as event}
              <div class="panel-surface p-4">
                <div class="flex items-center justify-between gap-4">
                  <div class="text-xs uppercase tracking-[0.18em] text-muted-foreground">{event.eventType}</div>
                  <Timestamp value={event.createdAt} />
                </div>
                <div class="mt-3 text-sm text-foreground">{event.message}</div>
                {#if Object.keys(event.payload).length > 0}
                  <pre class="mt-3 overflow-auto bg-background p-3 font-mono text-xs text-muted-foreground">{JSON.stringify(event.payload, null, 2)}</pre>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else if selectedTab === "logs"}
        <StreamLogPanel
          streamUrl={$selectedAttemptId ? `/api/attempts/${$selectedAttemptId}/logs/stream` : null}
          initialUrl={$selectedAttemptId ? `/api/attempts/${$selectedAttemptId}/logs` : null}
          emptyMessage="This attempt has not produced logs yet."
        />
      {:else}
        {#if $attemptDetailQuery.data.artifacts.length === 0}
          <EmptyState label="No artifacts attached to this attempt." />
        {:else}
          <div class="space-y-3">
            {#each $attemptDetailQuery.data.artifacts as artifact}
              <div class="panel-surface p-4">
                <div class="flex items-center justify-between gap-4">
                  <div class="text-sm text-foreground">{artifact.artifactType}</div>
                  <Timestamp value={artifact.createdAt} />
                </div>
                <div class="mt-2 space-y-1 text-sm text-muted-foreground">
                  <div>{artifact.relativePath}</div>
                  <div>{artifact.mediaType} · {artifact.sizeBytes} bytes</div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</Drawer>
