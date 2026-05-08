Foreman is agentic work orchestrator that scouts for incoming work from task and review systems and schedules the work amongst an agent worker pool.

## Planning

If a user asks to plan a task, ascertain the intended workspace if they have not specified, and then
read ./workspaces/<workspace>/plan.md to begin planning.

## UI

When working within the UI, follow these rules:

* Use design tokens and avoid using magic values.
* Layout spacing between children should be managed by the parent container.
* Avoid modifying core UI components in components/ui. Treat as vendored.

## Runner cohesion

Per-runner JSON parsing, token extraction, and other provider-specific output handling lives with the runner (`src/execution/impl/<runner>-runner.ts` or a sibling file such as `<runner>-output.ts`). Shared files (`json-output.ts`, `token-usage.ts`) hold runner-agnostic helpers and types only. Adding a new runner should not require editing existing runners' files.
