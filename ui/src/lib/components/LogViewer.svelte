<script lang="ts">
  import { renderSegmentStyle, type RenderedLogLine } from "../log-display";

  export let lines: RenderedLogLine[] = [];
  export let emptyMessage = "No log output yet.";
</script>

<div class="panel-surface min-h-[18rem] overflow-auto bg-background p-0">
  {#if lines.length === 0}
    <div class="p-4 text-sm text-muted-foreground">{emptyMessage}</div>
  {:else}
    <pre class="m-0 whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground">{#each lines as line, lineIndex}{#each line.segments as segment}<span class={segment.classes.join(" ")} style={renderSegmentStyle(segment.style)}>{segment.text}</span>{/each}{#if lineIndex < lines.length - 1}{"\n"}{/if}{/each}</pre>
  {/if}
</div>
