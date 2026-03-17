<script lang="ts">
  export let value: string;

  const statusClass = (status: string): string => {
    switch (status) {
      case "running":
      case "completed":
      case "proven":
        return "border-success/40 bg-success/10 text-success";
      case "paused":
      case "leased":
      case "in_progress":
      case "in_review":
      case "established":
        return "border-warning/40 bg-warning/10 text-warning";
      case "failed":
      case "blocked":
      case "canceled":
      case "timed_out":
      case "stopping":
        return "border-destructive/40 bg-destructive/10 text-destructive";
      case "ready":
      case "idle":
      case "emerging":
        return "border-info/40 bg-info/10 text-info";
      default:
        return "border-border bg-muted text-muted-foreground";
    }
  };
</script>

<span class={`inline-flex items-center border px-2 py-1 text-[11px] uppercase tracking-[0.18em] ${statusClass(value)}`}>
  {value.replaceAll("_", " ")}
</span>
