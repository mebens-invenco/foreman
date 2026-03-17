<script lang="ts">
  export let value = "";
  export let name: string | undefined = undefined;
</script>

<select bind:value {name} class="focus-ring h-9 w-full border border-input bg-background px-3 text-sm text-foreground">
  <slot />
</select>
