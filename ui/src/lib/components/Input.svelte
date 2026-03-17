<script lang="ts">
  export let value = "";
  export let placeholder = "";
  export let type = "text";
  export let name: string | undefined = undefined;
</script>

<input
  bind:value
  {placeholder}
  {type}
  {name}
  class="focus-ring h-9 w-full border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
/>
