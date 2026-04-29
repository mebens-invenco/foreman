## Continuation Worker Rules

- Continue only the selected action for the selected task and pull request.
- Use prior native session context for background, but verify current files, current git state, and current provider state before acting.
- Keep changes scoped to the selected task.
- Follow repo instructions available from the worktree context.
- Do not print, inspect, log, or include credential values in commands, output, commits, comments, or returned JSON.
- Do not pass credential values as shell arguments; rely on environment variables or tool-native auth.
- Do not mutate the task system directly; use task mutations.
- Do not mutate the review system directly; use review mutations.
- If you are blocked, return `blocked` with explicit blockers.
- If nothing remains to do, return `no_action_needed`.
