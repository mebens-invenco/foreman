<script lang="ts">
  import { onDestroy } from "svelte";

  import { appendLogChunk, appendSyntheticLogLine, createLogBuffer, getDisplayLines, type LogBuffer, type RenderedLogLine } from "../log-display";
  import { connectLogStream } from "../log-stream";
  import ErrorState from "./ErrorState.svelte";
  import LoadingState from "./LoadingState.svelte";
  import LogViewer from "./LogViewer.svelte";

  export let streamUrl: string | null = null;
  export let initialUrl: string | null = null;
  export let emptyMessage = "No logs yet.";
  export let includeAttemptChanges = false;

  let buffer: LogBuffer = createLogBuffer();
  let lines: RenderedLogLine[] = [];
  let error: string | null = null;
  let loading = false;
  let activeKey = "";
  let disconnect: () => void = () => {};
  let streamKey = "";

  const syncLines = (): void => {
    lines = getDisplayLines(buffer);
  };

  const resetBuffer = (): void => {
    buffer = createLogBuffer();
    syncLines();
  };

  const appendChunk = (chunk: string): void => {
    buffer = appendLogChunk(buffer, chunk);
    syncLines();
  };

  const appendAttemptChange = (attemptId: string | null): void => {
    buffer = appendSyntheticLogLine(buffer, attemptId ? `[worker switched to ${attemptId}]` : `[worker is idle]`);
    syncLines();
  };

  const withStreamOffset = (url: string, offset: number): string => {
    if (offset <= 0) {
      return url;
    }

    const nextUrl = new URL(url, window.location.origin);
    nextUrl.searchParams.set("offset", String(offset));
    return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  };

  const loadLogs = async (): Promise<void> => {
    const nextKey = `${streamUrl ?? ""}|${initialUrl ?? ""}|${includeAttemptChanges ? "1" : "0"}`;
    if (nextKey === activeKey) {
      return;
    }

    activeKey = nextKey;
    disconnect();
    resetBuffer();
    error = null;

    if (!streamUrl && !initialUrl) {
      loading = false;
      return;
    }

    loading = true;
    let initialOffset = 0;

    if (initialUrl) {
      try {
        const response = await fetch(initialUrl);
        if (response.ok) {
          const text = await response.text();
          initialOffset = text.length;
          appendChunk(text);
        }
      } catch {
        // ignore initial load failures and let the stream retry path carry the UI
      }
    }

    if (streamUrl) {
      disconnect = connectLogStream({
        streamUrl: withStreamOffset(streamUrl, initialOffset),
        onChunk: appendChunk,
        onAttemptChanged: includeAttemptChanges ? appendAttemptChange : undefined,
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
