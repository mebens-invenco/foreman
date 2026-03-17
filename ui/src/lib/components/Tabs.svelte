<script lang="ts">
  export let tabs: Array<{ value: string; label: string }> = [];
  export let value = "";
  export let onChange: (next: string) => void;
</script>

<div class="flex flex-wrap gap-2 border-b border-border pb-3">
  {#each tabs as tab}
    <button
      class={`focus-ring border px-3 py-2 text-xs uppercase tracking-[0.16em] ${value === tab.value ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"}`}
      on:click={() => onChange(tab.value)}
      type="button"
    >
      {tab.label}
    </button>
  {/each}
</div>
