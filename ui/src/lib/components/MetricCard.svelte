<script lang="ts">
  export let label: string;
  export let value: string | number;
  export let detail = "";
</script>

<div class="panel-surface p-4">
  <div class="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
  <div class="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
  {#if detail}
    <div class="mt-2 text-xs text-muted-foreground">{detail}</div>
  {/if}
</div>
