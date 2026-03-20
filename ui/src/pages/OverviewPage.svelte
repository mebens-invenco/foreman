<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";

  import { api, type QueueJob, type ScoutRun, type TaskListItem, type Worker } from "../lib/api";
  import { formatHeartbeat, formatRelativeTimestamp } from "../lib/format";
  import Card from "../lib/components/Card.svelte";
  import DataTable from "../lib/components/DataTable.svelte";
  import Drawer from "../lib/components/Drawer.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import ErrorState from "../lib/components/ErrorState.svelte";
  import LoadingState from "../lib/components/LoadingState.svelte";
  import StatusPill from "../lib/components/StatusPill.svelte";
  import StreamLogPanel from "../lib/components/StreamLogPanel.svelte";
  import Timestamp from "../lib/components/Timestamp.svelte";

  const statusQuery = createQuery({
    queryKey: ["status"],
    queryFn: api.fetchStatus,
    refetchInterval: 5000,
  });

  const workersQuery = createQuery({
    queryKey: ["workers"],
    queryFn: api.listWorkers,
    refetchInterval: 5000,
  });

  const queueQuery = createQuery({
    queryKey: ["queue"],
    queryFn: api.listQueue,
    refetchInterval: 5000,
  });

  const reviewTasksQuery = createQuery({
    queryKey: ["tasks", "in-review-overview"],
    queryFn: () => api.listTasks({ state: "in_review", limit: 8 }),
    refetchInterval: 10000,
  });

  const scoutRunsQuery = createQuery({
    queryKey: ["scout-runs"],
    queryFn: api.listScoutRuns,
    refetchInterval: 10000,
  });

  let selectedWorkerId: string | null = null;
  let workers: Worker[] = [];
  let queueJobs: QueueJob[] = [];
  let reviewTasks: TaskListItem[] = [];
  let scoutRuns: ScoutRun[] = [];

  $: workers = ($workersQuery.data ?? []) as Worker[];
  $: queueJobs = ($queueQuery.data ?? []) as QueueJob[];
  $: reviewTasks = ($reviewTasksQuery.data ?? []) as TaskListItem[];
  $: scoutRuns = ($scoutRunsQuery.data ?? []) as ScoutRun[];
  $: selectedWorker = workers.find((worker) => worker.id === selectedWorkerId) ?? null;
</script>

<div class="space-y-6">
  {#if $statusQuery.isError}
    <ErrorState message={$statusQuery.error instanceof Error ? $statusQuery.error.message : "Failed to load overview."} />
  {/if}

  <section>
    {#if $workersQuery.isPending}
      <LoadingState label="Loading workers..." />
    {:else if workers.length === 0}
      <EmptyState label="No workers available." />
    {:else}
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {#each workers as worker}
          <button class="panel-surface focus-ring flex min-h-[12rem] flex-col items-start gap-4 p-4 text-left hover:bg-muted/40" on:click={() => (selectedWorkerId = worker.id)} type="button">
            <div class="flex w-full items-start justify-between gap-3">
              <div>
                <div class="text-xs uppercase tracking-[0.18em] text-muted-foreground">Worker {worker.slot}</div>
                <div class="mt-2 font-mono text-xs text-foreground">{worker.id}</div>
              </div>
              <StatusPill value={worker.status} />
            </div>

            {#if worker.currentJob}
              <div class="space-y-2 text-sm text-foreground">
                <div class="font-mono text-xs">{worker.currentJob.taskId}</div>
                <div>{worker.currentJob.action} - {worker.currentJob.repoKey}</div>
                <div class="font-mono text-xs text-muted-foreground">{worker.currentAttempt?.id ?? worker.currentAttemptId}</div>
              </div>
            {:else}
              <div class="text-sm text-muted-foreground">Idle</div>
            {/if}

            <div class="mt-auto space-y-1 text-sm text-muted-foreground">
              <div>Heartbeat {formatHeartbeat(worker.lastHeartbeatAt)}</div>
              {#if worker.currentAttempt?.startedAt}
                <div>Started {formatRelativeTimestamp(worker.currentAttempt.startedAt)}</div>
              {/if}
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <section class="grid gap-6 xl:grid-cols-3">
    <section>
      <header class="border-b border-border pb-3">
        <h2 class="m-0 text-xs uppercase tracking-[0.18em] text-muted-foreground">Needs Review</h2>
      </header>
      <div class="pt-4">
        {#if reviewTasks.length === 0}
          <EmptyState label="No tasks in review right now." />
        {:else}
          <div class="space-y-2">
            {#each reviewTasks as task}
              {@const primaryTarget = task.targets[0] ?? null}
              <div class="panel-surface p-3">
                <div class="flex items-center justify-between gap-3">
                  {#if primaryTarget?.review?.pullRequestUrl}
                    <a
                      class="font-mono text-xs text-foreground underline-offset-4 hover:text-primary hover:underline"
                      href={primaryTarget.review.pullRequestUrl}
                      target="_blank"
                      rel="noreferrer"
                      on:click|stopPropagation
                    >
                      {task.id}
                    </a>
                  {:else}
                    <div class="font-mono text-xs text-foreground">{task.id}</div>
                  {/if}
                  <StatusPill value={task.state} />
                </div>
                {#if primaryTarget?.review?.pullRequestUrl}
                  <a
                    class="mt-2 block text-sm text-foreground underline-offset-4 hover:text-primary hover:underline"
                    href={primaryTarget.review.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                    on:click|stopPropagation
                  >
                    {task.title}
                  </a>
                {:else}
                  <div class="mt-2 text-sm text-foreground">{task.title}</div>
                {/if}
                <div class="mt-1 text-sm text-muted-foreground">{primaryTarget?.repoKey ?? task.repo ?? "No repo"}</div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <section>
      <header class="border-b border-border pb-3">
        <h2 class="m-0 text-xs uppercase tracking-[0.18em] text-muted-foreground">Active Queue</h2>
      </header>
      <div class="pt-4">
      {#if $queueQuery.isPending}
        <LoadingState label="Loading queue..." />
      {:else if queueJobs.length === 0}
        <EmptyState label="Queue is empty." />
      {:else}
        <DataTable>
          <thead class="bg-muted/40 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <tr>
              <th class="px-3 py-2">Task</th>
              <th class="px-3 py-2">Action</th>
              <th class="px-3 py-2">Repo</th>
              <th class="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {#each queueJobs.slice(0, 8) as job}
              <tr class="border-t border-border">
                <td class="px-3 py-3 font-mono text-xs text-foreground">{job.taskId}</td>
                <td class="px-3 py-3"><StatusPill value={job.action} /></td>
                <td class="px-3 py-3 text-muted-foreground">{job.repoKey}</td>
                <td class="px-3 py-3"><Timestamp value={job.createdAt} /></td>
              </tr>
            {/each}
          </tbody>
        </DataTable>
      {/if}
      </div>
    </section>

    <section>
      <header class="border-b border-border pb-3">
        <h2 class="m-0 text-xs uppercase tracking-[0.18em] text-muted-foreground">Recent Scout Runs</h2>
      </header>
      <div class="pt-4">
      {#if $scoutRunsQuery.isPending}
        <LoadingState label="Loading scout runs..." />
      {:else if scoutRuns.length === 0}
        <EmptyState label="No scout runs recorded yet." />
      {:else}
        <DataTable>
          <thead class="bg-muted/40 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <tr>
              <th class="px-3 py-2">Trigger</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2">Selected</th>
              <th class="px-3 py-2">Started</th>
            </tr>
          </thead>
          <tbody>
            {#each scoutRuns.slice(0, 8) as run}
              <tr class="border-t border-border align-top">
                <td class="px-3 py-3 text-sm text-foreground">{run.triggerType}</td>
                <td class="px-3 py-3"><StatusPill value={run.status} /></td>
                <td class="px-3 py-3 text-sm text-muted-foreground">{run.selectedTaskId ? `${run.selectedAction ?? "selected"} ${run.selectedTaskId}` : "No selection"}</td>
                <td class="px-3 py-3"><Timestamp value={run.startedAt} /></td>
              </tr>
            {/each}
          </tbody>
        </DataTable>
      {/if}
      </div>
    </section>
  </section>
</div>

<Drawer open={selectedWorker !== null} title={selectedWorker ? `Worker ${selectedWorker.slot}` : "Worker"} onClose={() => (selectedWorkerId = null)}>
  {#if selectedWorker}
    <div class="space-y-6">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="panel-surface p-4">
          <div class="text-xs uppercase tracking-[0.18em] text-muted-foreground">Status</div>
          <div class="mt-3"><StatusPill value={selectedWorker.status} /></div>
        </div>
        <div class="panel-surface p-4">
          <div class="text-xs uppercase tracking-[0.18em] text-muted-foreground">Heartbeat</div>
          <div class="mt-3 text-sm text-foreground">{formatHeartbeat(selectedWorker.lastHeartbeatAt)}</div>
        </div>
      </div>

      <Card title="Worker Detail">
        <div class="space-y-2 text-sm text-muted-foreground">
          <div><span class="text-foreground">Worker ID:</span> <span class="font-mono text-xs">{selectedWorker.id}</span></div>
          <div><span class="text-foreground">Current attempt:</span> {selectedWorker.currentAttemptId ?? "idle"}</div>
          <div><span class="text-foreground">Task:</span> {selectedWorker.currentJob?.taskId ?? "-"}</div>
          <div><span class="text-foreground">Action:</span> {selectedWorker.currentJob?.action ?? "-"}</div>
          <div><span class="text-foreground">Repo:</span> {selectedWorker.currentJob?.repoKey ?? "-"}</div>
        </div>
      </Card>

      <Card title="Live Log">
        <StreamLogPanel streamUrl={`/api/workers/${selectedWorker.id}/logs/stream`} emptyMessage="Worker has not produced logs yet." includeAttemptChanges={true} />
      </Card>
    </div>
  {/if}
</Drawer>
