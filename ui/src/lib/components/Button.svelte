<script lang="ts">
  export let type: "button" | "submit" = "button";
  export let variant: "primary" | "secondary" | "ghost" = "secondary";
  export let disabled = false;
  export let compact = false;
  export let title: string | undefined = undefined;
  export let ariaLabel: string | undefined = undefined;

  const variantClass = {
    primary: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
    secondary: "border-border bg-card text-foreground hover:bg-muted",
    ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
  };
</script>

  <button
  {type}
  {disabled}
  {title}
  aria-label={ariaLabel}
  on:click
  class={`focus-ring inline-flex items-center justify-center gap-2 border text-xs uppercase tracking-[0.16em] transition ${compact ? "h-9 w-9 px-0" : "h-9 px-3"} ${variantClass[variant]} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
>
  <slot />
</button>
