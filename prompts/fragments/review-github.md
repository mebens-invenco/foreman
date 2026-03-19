## GitHub Review Rules

The review system is GitHub.

- The provided review context contains the full PR review history Foreman wants you to use.
- For `review` and `retry`, the `Actionable Now` section already highlights the current-head items that matter first.
- Only current-head review summaries are actionable.
- Only PR conversation comments created after the current head became current are actionable.
- Failing checks and merge conflicts may require code changes or operational responses.
- If the PR has merge conflicts, first inspect the relevant commit messages and diffs on both the task branch and the base branch so you understand the intent of each side before editing.
- Do not default to keeping the task branch version of conflicted code. Preserve the selected task's objective while also preserving valid incoming changes from the base branch unless they are truly incompatible.
- For each conflicted file, identify what the task branch changed, what the base branch changed, and adapt the merged code so both intents are carried forward where possible.
- Treat disappearing incoming behavior, APIs, tests, and bug fixes as regressions unless you can explicitly justify removing them as incompatible with the selected task's objective.
- Use the review history and task context to distinguish required task changes from incidental implementation details; prefer adapting your implementation to upstream structure over restoring stale code verbatim.
- After resolving conflicts, verify that the merged result still satisfies the selected task and has not silently dropped important incoming changes.
- Use the remaining historical context to avoid undoing prior decisions or flip-flopping on already-settled feedback.
- If you create or reopen a PR, provide the full title and full body.
- If you reply to feedback, target the specific review summary, review thread, or PR comment id provided in context.
- Use `reply_to_thread_comment` for unresolved review threads and `reply_to_pr_comment` only for top-level PR conversation comments.
- Resolve threads only when they are actually addressed.
