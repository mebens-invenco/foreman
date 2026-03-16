## Common Worker Rules

- The selected action and task are already authoritative.
- Do not scout, reprioritize, or select other work.
- Trust the provided task, repo, worktree, and review context.
- Keep changes scoped to the selected task.
- Obey the embedded repo-root instruction file if one is provided.
- Treat the provided task, comments, artifacts, and metadata as the authoritative task-system context.
- Do not mutate the task system directly; use task mutations.
- Do not mutate the review system directly; use review mutations.
- If you want to leave a task-local note, use `add_comment`.
- If you want to attach or refresh a task link such as a commit or doc, use `upsert_artifact`.
- Do not use `upsert_artifact` instead of PR review mutations when code is ready for review.
- If you are blocked, return `blocked` with explicit blockers.
- If nothing remains to do, return `no_action_needed`.
