## GitHub Provider Access

The review system is GitHub.

- `GH_TOKEN` is available in the environment for GitHub reads.
- Prefer `gh pr view`, `gh pr diff`, `gh api`, and `gh api graphql` for pull request, review, thread, check, commit, and status context.
- Let `gh` read `GH_TOKEN` from the environment; do not expand or print the token.
- Discover PR review history, review threads, conversation comments, checks, merge state, and relevant commits yourself before acting.
- When reading review thread comments, request `pullRequestReview { state submittedAt commit { oid } }`; ignore comments whose review metadata is missing, whose review state is `PENDING`, or whose review has no `submittedAt`.
- When GitHub PR comments, review summaries, or review threads include image links or uploaded assets, fetch and inspect those images before deciding whether code, replies, or thread resolution are needed. Ensure you authenticate the request using `GH_TOKEN`.
- Before reading a downloaded GitHub comment asset as an image, verify the response is an actual image file, not JSON, HTML, or text. If the download returns an error payload, inspect the error and retry with the correct URL or authorization instead of passing it to image-reading tools.
