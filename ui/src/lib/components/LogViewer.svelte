<script lang="ts">
  export let lines: string[] = [];
  export let emptyMessage = "No log output yet.";
</script>

<div class="panel-surface min-h-[18rem] overflow-auto bg-background p-0">
  {#if lines.length === 0}
    <div class="p-4 text-sm text-muted-foreground">{emptyMessage}</div>
  {:else}
    <pre class="m-0 whitespace-pre-wrap p-4 font-mono text-xs leading-6 text-foreground">{lines.join("\n")}</pre>
  {/if}
</div>
