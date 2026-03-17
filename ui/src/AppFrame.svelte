<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { onDestroy, onMount } from "svelte";
  import type { QueryClient } from "@tanstack/svelte-query";

  import { api } from "./lib/api";
  import AppShell from "./lib/components/AppShell.svelte";
  import ErrorState from "./lib/components/ErrorState.svelte";
  import { normalizePath, pages, titleForPath, type PagePath } from "./lib/navigation";
  import AttemptsPage from "./pages/AttemptsPage.svelte";
  import HistoryPage from "./pages/HistoryPage.svelte";
  import LearningsPage from "./pages/LearningsPage.svelte";
  import OverviewPage from "./pages/OverviewPage.svelte";

  export let queryClient: QueryClient;

  let currentPath: PagePath = normalizePath(typeof window === "undefined" ? "/overview" : window.location.pathname);
  let actionPending: string | null = null;
  let actionError: string | null = null;

  const statusQuery = createQuery({
    queryKey: ["status"],
    queryFn: api.fetchStatus,
    refetchInterval: 5000,
  });

  const syncPath = (): void => {
    currentPath = normalizePath(window.location.pathname);
  };

  const navigate = (path: PagePath): void => {
    if (path === currentPath) {
      return;
    }

    history.pushState({}, "", path);
    syncPath();
  };

  const runAction = async (action: "start" | "pause" | "stop"): Promise<void> => {
    actionPending = action;
    actionError = null;
    try {
      await api.postSchedulerAction(action);
      await queryClient.invalidateQueries();
    } catch (error) {
      actionError = error instanceof Error ? error.message : `Failed to ${action} scheduler.`;
    } finally {
      actionPending = null;
    }
  };

  const runScout = async (): Promise<void> => {
    actionPending = "scout";
    actionError = null;
    try {
      await api.runScout();
      await queryClient.invalidateQueries();
    } catch (error) {
      actionError = error instanceof Error ? error.message : "Failed to trigger scout.";
    } finally {
      actionPending = null;
    }
  };

  $: document.title = `Foreman - ${titleForPath(currentPath)}`;
  $: workspaceName = $statusQuery.data?.workspace.name ?? "Foreman";
  $: schedulerStatus = $statusQuery.data?.scheduler.status ?? "unknown";
  $: pageTitle = titleForPath(currentPath);

  onMount(() => {
    window.addEventListener("popstate", syncPath);
  });

  onDestroy(() => {
    window.removeEventListener("popstate", syncPath);
  });
</script>

<AppShell
  {pages}
  {currentPath}
  {workspaceName}
  {schedulerStatus}
  {actionPending}
  onNavigate={navigate}
  onSchedulerAction={runAction}
  onRunScout={runScout}
>
  {#if actionError}
    <div class="mb-6">
      <ErrorState message={actionError} />
    </div>
  {/if}

  {#if currentPath === "/overview"}
    <OverviewPage />
  {:else if currentPath === "/attempts"}
    <AttemptsPage />
  {:else if currentPath === "/history"}
    <HistoryPage />
  {:else}
    <LearningsPage />
  {/if}
</AppShell>
