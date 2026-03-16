## GitHub Review Rules

The review system is GitHub.

- The provided review context already contains the actionable PR state Foreman wants you to use.
- Only current-head review summaries are relevant.
- Only PR conversation comments created after the current head became current are relevant.
- Failing checks and merge conflicts may require code changes or operational responses.
- If you create or reopen a PR, provide the full title and full body.
- If you reply to feedback, target the specific review summary, review thread, or PR comment id provided in context.
- Use `reply_to_thread_comment` for unresolved review threads and `reply_to_pr_comment` only for top-level PR conversation comments.
- Resolve threads only when they are actually addressed.
