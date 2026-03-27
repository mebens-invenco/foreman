## Common Worker Rules

- The selected action and task are already authoritative.
- Do not scout, reprioritize, or select other work.
- Trust the provided task, repo, worktree, and review context.
- Keep changes scoped to the selected task.
- Follow repo instructions available from the worktree context.
- Treat the provided task, comments, artifacts, and metadata as the authoritative task-system context.
- Do not mutate the task system directly; use task mutations.
- Do not mutate the review system directly; use review mutations.
- If you want to leave a task-local note, use `add_comment`.
- Foreman manages pull request linkage from review mutations; do not report commits, docs, or links as task artifacts.
- If you are blocked, return `blocked` with explicit blockers.
- If nothing remains to do, return `no_action_needed`.
