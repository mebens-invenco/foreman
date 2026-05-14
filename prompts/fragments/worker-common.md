## Common Worker Rules

- The selected action and task are already authoritative.
- Do not scout, reprioritize, or select other work.
- Treat the provided task, repo, worktree, provider references, and pull request reference as bootstrap context.
- Discover detailed task, comment, review, check, and provider history yourself using the provider access instructions.
- Keep changes scoped to the selected task.
- Follow repo instructions available from the worktree context.
- Do not detach `HEAD` in the worktree. Never check out a commit SHA directly (`git checkout <sha>`, `git checkout HEAD~N`, `git switch --detach`) — that leaves the worktree on a detached HEAD and breaks the next attempt. To inspect a specific commit use `git show <sha>`, `git diff <sha>...<sha>`, or `git log -p <sha> -1`. To inspect a PR's state without modifying the worktree, prefer `gh pr diff <pr>` or read the diff from the GitHub API. `gh pr checkout <pr-number>` is fine because it checks out the PR's branch; only avoid `gh pr checkout` when used against a raw commit.
- Do not print, inspect, log, or include credential values in commands, output, commits, comments, or returned JSON.
- Do not pass credential values as shell arguments; rely on environment variables or tool-native auth.
- Do not mutate the task system directly; use task mutations.
- Do not mutate the review system directly; use review mutations.
- If you want to leave a task-local note, use `add_comment`.
- Foreman manages pull request linkage from review mutations; do not report commits, docs, or links as task artifacts.
- If you are blocked, return `blocked` with explicit blockers.
- If nothing remains to do, return `no_action_needed`.
