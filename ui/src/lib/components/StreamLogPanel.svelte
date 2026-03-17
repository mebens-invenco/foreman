<script lang="ts">
  import { onDestroy } from "svelte";

  import { connectLogStream } from "../log-stream";
  import ErrorState from "./ErrorState.svelte";
  import LoadingState from "./LoadingState.svelte";
  import LogViewer from "./LogViewer.svelte";

  export let streamUrl: string | null = null;
  export let initialUrl: string | null = null;
  export let emptyMessage = "No logs yet.";
  export let includeAttemptChanges = false;

  let lines: string[] = [];
  let error: string | null = null;
  let loading = false;
  let activeKey = "";
  let disconnect: () => void = () => {};
  let streamKey = "";

  const appendLine = (line: string): void => {
    lines = [...lines, line].slice(-500);
  };

  const loadLogs = async (): Promise<void> => {
    const nextKey = `${streamUrl ?? ""}|${initialUrl ?? ""}|${includeAttemptChanges ? "1" : "0"}`;
    if (nextKey === activeKey) {
      return;
    }

    activeKey = nextKey;
    disconnect();
    lines = [];
    error = null;

    if (!streamUrl && !initialUrl) {
      loading = false;
      return;
    }

    loading = true;

    if (initialUrl) {
      try {
        const response = await fetch(initialUrl);
        if (response.ok) {
          const text = await response.text();
          lines = text ? text.split(/\r?\n/).filter(Boolean).slice(-500) : [];
        }
      } catch {
        // ignore initial load failures and let the stream retry path carry the UI
      }
    }

    if (streamUrl) {
      disconnect = connectLogStream({
        streamUrl,
        onLine: appendLine,
        onAttemptChanged: includeAttemptChanges
          ? (attemptId) => appendLine(attemptId ? `[worker switched to ${attemptId}]` : `[worker is idle]`)
          : undefined,
        onError: () => {
          error = "Live log stream disconnected.";
        },
      });
    }

    loading = false;
  };

  $: streamKey = `${streamUrl ?? ""}|${initialUrl ?? ""}|${includeAttemptChanges ? "1" : "0"}`;
  $: if (streamKey !== activeKey) {
    void loadLogs();
  }

  onDestroy(() => {
    disconnect();
  });
</script>

{#if error}
  <ErrorState message={error} />
{:else if loading && lines.length === 0}
  <LoadingState label="Loading logs..." />
{:else}
  <LogViewer {lines} {emptyMessage} />
{/if}
