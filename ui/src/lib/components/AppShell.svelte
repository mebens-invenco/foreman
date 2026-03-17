<script lang="ts">
  import type { PageDefinition, PagePath } from "../navigation";
  import Button from "./Button.svelte";
  import StatusPill from "./StatusPill.svelte";

  export let pages: PageDefinition[];
  export let currentPath: PagePath;
  export let workspaceName = "Foreman";
  export let schedulerStatus = "unknown";
  export let actionPending: string | null = null;
  export let onNavigate: (path: PagePath) => void;
  export let onSchedulerAction: (action: "start" | "pause" | "stop") => void;
  export let onRunScout: () => void;

  $: startDisabled = actionPending !== null || schedulerStatus === "running";
  $: pauseDisabled = actionPending !== null || schedulerStatus !== "running";
  $: stopDisabled = actionPending !== null || schedulerStatus === "stopped";
  $: scoutDisabled = actionPending !== null || schedulerStatus !== "running";
</script>

<div class="min-h-screen bg-background text-foreground">
  <header class="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-sm">
    <div class="flex min-h-16 flex-wrap items-center justify-between gap-4 px-4 sm:px-6">
      <div class="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
        <div class="text-xs uppercase tracking-[0.28em] text-primary">{workspaceName}</div>
        <div class="hidden h-5 w-px bg-border sm:block"></div>
        <nav class="min-w-0 overflow-x-auto">
          <div class="flex min-w-max items-center gap-2">
            {#each pages as page}
              <a
                href={page.path}
                class={`focus-ring inline-flex min-w-fit items-center border px-3 py-2 text-xs uppercase tracking-[0.16em] ${page.path === currentPath ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                on:click|preventDefault={() => onNavigate(page.path)}
              >
                {page.label}
              </a>
            {/each}
          </div>
        </nav>
      </div>

      <div class="flex flex-wrap items-center justify-end gap-2">
        <StatusPill value={schedulerStatus} />
        <Button variant="ghost" disabled={scoutDisabled} on:click={() => onRunScout()}>Run Scout</Button>
        <Button compact={true} variant="secondary" disabled={startDisabled} title="Start scheduler" ariaLabel="Start scheduler" on:click={() => onSchedulerAction("start")}>
          <svg aria-hidden="true" class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3.2v9.6L12.4 8 4 3.2Z" /></svg>
          <span class="sr-only">Start</span>
        </Button>
        <Button compact={true} variant="secondary" disabled={pauseDisabled} title="Pause scheduler" ariaLabel="Pause scheduler" on:click={() => onSchedulerAction("pause")}>
          <svg aria-hidden="true" class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zM9 3h3v10H9z" /></svg>
          <span class="sr-only">Pause</span>
        </Button>
        <Button compact={true} variant="secondary" disabled={stopDisabled} title="Stop scheduler" ariaLabel="Stop scheduler" on:click={() => onSchedulerAction("stop")}>
          <svg aria-hidden="true" class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h8v8H4z" /></svg>
          <span class="sr-only">Stop</span>
        </Button>
      </div>
    </div>
  </header>

  <main class="min-w-0 p-4 sm:p-6">
    <slot />
  </main>
</div>
