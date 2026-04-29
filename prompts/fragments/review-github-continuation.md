## GitHub Continuation Access

The review system is GitHub.

- `GH_TOKEN` is available in the environment for GitHub reads.
- Prefer `gh pr view`, `gh pr diff`, `gh api`, and `gh api graphql` for pull request, review, thread, check, commit, and status context.
- Let `gh` read `GH_TOKEN` from the environment; do not expand or print the token.
- Rediscover current PR review history, review threads, conversation comments, checks, merge state, and relevant commits before acting.
- Return all GitHub writes as Foreman review mutations instead of calling write APIs directly.
