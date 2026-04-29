## GitHub Provider Access

The review system is GitHub.

- `GH_TOKEN` is available in the environment for GitHub reads.
- Prefer `gh pr view`, `gh pr diff`, `gh api`, and `gh api graphql` for pull request, review, thread, check, commit, and status context.
- Let `gh` read `GH_TOKEN` from the environment; do not expand or print the token.
- Discover PR review history, review threads, conversation comments, checks, merge state, and relevant commits yourself before acting.
- For `review` and `retry`, determine current-head review summaries, unresolved review threads, post-head PR comments, failing checks, and merge conflicts from GitHub directly.
- Only current-head review summaries are actionable.
- Only PR conversation comments created after the current head became current are actionable; use `Pull Request Reference.headIntroducedAt` as the cutoff when filtering post-head conversation comments.
- Failing checks and merge conflicts may require code changes or operational responses.
- If the PR has merge conflicts, first inspect the relevant commit messages and diffs on both the task branch and the base branch so you understand the intent of each side before editing.
- Do not default to keeping the task branch version of conflicted code. Preserve the selected task's objective while also preserving valid incoming changes from the base branch unless they are truly incompatible.
- For each conflicted file, identify what the task branch changed, what the base branch changed, and adapt the merged code so both intents are carried forward where possible.
- Treat disappearing incoming behavior, APIs, tests, and bug fixes as regressions unless you can explicitly justify removing them as incompatible with the selected task's objective.
- Use the discovered review history and task context to distinguish required task changes from incidental implementation details; prefer adapting your implementation to upstream structure over restoring stale code verbatim.
- After resolving conflicts, verify that the merged result still satisfies the selected task and has not silently dropped important incoming changes.
- Use historical GitHub context to avoid undoing prior decisions or flip-flopping on already-settled feedback.
- When actionable review state conflicts with later maintainer-authored comments in the PR history, treat the later maintainer decision as authoritative for that behavior, even if an older or stale current-head summary still requests a change.
- If that kind of conflict exists, prefer a review reply explaining that the older feedback was superseded instead of changing code.
- Do not treat existing uncommitted worktree changes as evidence that a requested change should still be completed; they are non-authoritative unless they match the maintainer-approved direction.
- If you create or reopen a PR, provide the full title and full body.
- If you reply to feedback, target the specific review summary, review thread, or PR comment id discovered from GitHub.
- Use `reply_to_thread_comment` for unresolved review threads and `reply_to_pr_comment` only for top-level PR conversation comments.
- Resolve threads only when they are actually addressed.
- Return all GitHub writes as Foreman review mutations instead of calling write APIs directly.
