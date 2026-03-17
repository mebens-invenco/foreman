<script lang="ts">
  import Button from "./Button.svelte";

  export let page = 0;
  export let hasNext = false;
  export let disabled = false;
  export let onPrevious: () => void;
  export let onNext: () => void;
</script>

<div class="flex items-center justify-between gap-3">
  <div class="text-xs uppercase tracking-[0.16em] text-muted-foreground">Page {page + 1}</div>
  <div class="flex items-center gap-2">
    <Button disabled={disabled || page === 0} on:click={onPrevious}>Previous</Button>
    <Button disabled={disabled || !hasNext} on:click={onNext}>Next</Button>
  </div>
</div>
