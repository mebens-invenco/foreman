## GitHub Provider Access

The review system is GitHub.

- `GH_TOKEN` is available in the environment for task-scoped GitHub reads and writes permitted by the selected action.
- Prefer `gh pr view`, `gh pr diff`, `gh api`, and `gh api graphql` for pull request, review, thread, check, commit, and status context.
- Let `gh` read `GH_TOKEN` from the environment; do not expand or print the token.
- Discover PR review history, review threads, conversation comments, checks, merge state, and relevant commits yourself before acting.
- When reading review thread comments, request `pullRequestReview { state submittedAt commit { oid } }`; ignore comments whose review metadata is missing, whose review state is `PENDING`, or whose review has no `submittedAt`.
- When GitHub PR comments, review summaries, or review threads include image links or uploaded assets, fetch and inspect those images before deciding whether code, replies, or thread resolution are needed. Ensure you authenticate the request using `GH_TOKEN`.
- Before reading a downloaded GitHub comment asset as an image, verify the response is an actual image file, not JSON, HTML, or text. If the download returns an error payload, inspect the error and retry with the correct URL or authorization instead of passing it to image-reading tools.

## GitHub Operations

- Use `gh pr create`, `gh pr edit`, `gh api`, or `gh api graphql` to complete the assigned workflow. Follow repository templates and attachment instructions, including native `--attach` where required. Keep local images outside the repository.
- Use the selected repository, head branch, and base branch explicitly. Discover an existing open PR for the task branch before creating one. Preserve human edits when updating its body.
- Inspect remote state before retrying an ambiguous or failed write. `gh pr create --attach` can create a PR and print its URL even when an upload fails and the command exits non-zero. Inspect that PR and complete only missing uploads using `gh pr edit`.
- Keep retries bounded. Recover only from the specific error observed: re-read the diff for invalid inline locations, inspect your own pending review before submitting it, and check whether a missing thread was deleted. Preserve findings if an inline location cannot be repaired. Report authentication, permissions, and unresolved publication errors honestly.
- A successful write followed by a local failure is still published. Inspect existing PRs, reviews, and replies before continuing so recovery does not duplicate them.
- Return `reviewResult` with the confirmed PR URL. For reviewer actions also return the full `reviewedHeadSha` and submitted review GraphQL node IDs (`node_id` from REST), not numeric REST IDs. A completed reviewer pass requires a confirmed submitted review; a no-action reviewer pass includes the reviewed SHA and no submitted IDs.
- If work is incomplete, return `blocked` or `failed` with confirmed references and the remaining work in the summary/blockers. Finding an existing PR alone does not mean the assignment is complete.

{{context:comment-attribution}}
