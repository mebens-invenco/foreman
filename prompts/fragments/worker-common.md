## Common Worker Rules

- The selected action and task are already authoritative.
- Do not scout, reprioritize, or select other work.
- Treat the provided task, repo, worktree, provider references, and pull request reference as bootstrap context.
- Discover detailed task, comment, review, check, and provider history yourself using the provider access instructions.
- Keep changes scoped to the selected task.
- Follow repo instructions available from the worktree context.
- Do not print, inspect, log, or include credential values in commands, output, commits, comments, or returned JSON.
- Do not pass credential values as shell arguments; rely on environment variables or tool-native auth.
- Do not mutate the task system directly; use task mutations.
- Do not mutate the review system directly; use review mutations.
- If you want to leave a task-local note, use `add_comment`.
- Foreman manages pull request linkage from review mutations; do not report commits, docs, or links as task artifacts.
- If you are blocked, return `blocked` with explicit blockers.
- If nothing remains to do, return `no_action_needed`.
