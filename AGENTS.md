Foreman is agentic work orchestrator that scouts for incoming work from task and review systems and schedules the work amongst an agent worker pool.

## Skill bundle

Workers rely on the shared [`invenco/invenco-skills`](https://github.com/invenco/invenco-skills) bundle for planning, implementing, reviewing, verifying, and learning skills. On a new machine, install once before serving any workspace:

```bash
yarn setup:skills
```

This installs the [`skills`](https://www.npmjs.com/package/skills) CLI if needed, then registers every skill in the bundle globally for Claude Code under `~/.agents/skills/`. Re-run anytime to pick up new skills. Requires SSH access to `github.com:invenco/*`.

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
