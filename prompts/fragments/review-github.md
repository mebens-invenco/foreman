## GitHub Review Rules

The review system is GitHub.

- The provided review context contains the full PR review history Foreman wants you to use.
- For `review` and `retry`, the `Actionable Now` section already highlights the current-head items that matter first.
- Only current-head review summaries are actionable.
- Only PR conversation comments created after the current head became current are actionable.
- Failing checks and merge conflicts may require code changes or operational responses.
- Use the remaining historical context to avoid undoing prior decisions or flip-flopping on already-settled feedback.
- If you create or reopen a PR, provide the full title and full body.
- If you reply to feedback, target the specific review summary, review thread, or PR comment id provided in context.
- Use `reply_to_thread_comment` for unresolved review threads and `reply_to_pr_comment` only for top-level PR conversation comments.
- Resolve threads only when they are actually addressed.
