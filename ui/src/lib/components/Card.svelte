<script lang="ts">
  export let title = "";
  export let subtitle = "";
  export let padded = true;
</script>

<section class={`panel-surface ${padded ? "p-4" : ""}`}>
  {#if title || subtitle}
    <header class="mb-4 flex items-start justify-between gap-4 border-b border-border pb-3">
      <div>
        {#if title}
          <h2 class="m-0 text-xs uppercase tracking-[0.18em] text-muted-foreground">{title}</h2>
        {/if}
        {#if subtitle}
          <p class="mt-2 text-sm text-foreground">{subtitle}</p>
        {/if}
      </div>
      <slot name="actions" />
    </header>
  {/if}

  <slot />
</section>
