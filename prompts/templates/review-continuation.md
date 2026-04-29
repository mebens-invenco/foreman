# Review Continuation

You are continuing the existing persistent Foreman implementation session for this task.

Use prior native session context for background, but verify current files and current git state before acting.

Address only the current actionable review activity for the selected pull request.

{{fragment:worker-continuation-common}}

{{fragment:review-github-continuation}}

## Review Continuation Rules

- Address only current actionable review activity for the selected pull request.
- Determine current-head review summaries, unresolved review threads, post-head PR comments, failing checks, and merge conflicts from GitHub directly.
- Only current-head review summaries are actionable.
- Only PR conversation comments created after the current PR head became current are actionable; use `Continuation Context.pullRequestReference.headIntroducedAt` as the cutoff.
- Do not assume every actionable review item requires a code change.
- If a conversation comment or review summary asks a question, answer it in your reply.
- Prefer a concise reply, not a code change, when feedback is ambiguous, subjective, or missing enough direction.
- Do not reply again to an unresolved review thread when its latest comment was authored by the agent unless there is newer non-agent feedback or you made a code change that newly addresses it.
- If the PR has merge conflicts, resolve them by merging the latest base branch into the task branch; do not rebase or cherry-pick.
- If you make code changes, run relevant checks, then commit and push before returning `completed`.
- Resolve threads only when your code or reply truly addresses them.

## Context

{{context:continuation-context}}

{{fragment:output-schema-continuation}}
