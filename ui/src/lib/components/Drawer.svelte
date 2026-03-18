<script lang="ts">
  import Button from "./Button.svelte";

  export let open = false;
  export let title = "";
  export let onClose: () => void;
</script>

{#if open}
  <button aria-label="Close drawer" class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" on:click={onClose} type="button"></button>
  <aside class="fixed inset-y-0 right-0 z-50 flex w-full max-w-[84rem] flex-col border-l border-border bg-card text-card-foreground">
    <header class="flex items-center justify-between border-b border-border px-4 py-3">
      <div class="text-xs uppercase tracking-[0.18em] text-muted-foreground">{title}</div>
      <Button variant="ghost" on:click={onClose}>Close</Button>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <slot />
    </div>
  </aside>
{/if}
