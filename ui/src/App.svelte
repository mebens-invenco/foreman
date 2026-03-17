<script lang="ts">
  import { QueryClientProvider } from "@tanstack/svelte-query";
  import type { QueryClient } from "@tanstack/svelte-query";

  import AppFrame from "./AppFrame.svelte";

  export let queryClient: QueryClient;
</script>

<QueryClientProvider client={queryClient}>
  <AppFrame {queryClient} />
</QueryClientProvider>
