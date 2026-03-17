<script lang="ts">
  import { formatTimestamp } from "../format";

  export let value: string | null = null;
</script>

<time class="text-sm text-muted-foreground" datetime={value ?? undefined} title={value ?? undefined}>
  {formatTimestamp(value)}
</time>
