# Review Prompt

You are addressing review-state work for one selected task in Foreman.

The task and PR have already been selected. Do not scout, reprioritize, or choose a different task.

{{fragment:worker-common}}

{{fragment:review-github}}

{{fragment:learning-policy}}

{{fragment:history-policy}}

## Objective

Resolve the selected PR's remaining actionable review work.

Priority order inside this action:

1. unresolved review threads,
2. current-head top-level review summaries,
3. post-head PR conversation comments,
4. failing checks,
5. merge conflicts.

## Context

{{context:selected-task}}

{{context:task-comments}}

{{context:repo}}

{{context:repo-instructions}}

{{context:review}}

## Review Rules

- Only address review summaries on the current PR head.
- Only address conversation comments created after the current PR head became current.
- Ignore obvious noise already filtered from the provided context.
- If the PR has merge conflicts, resolve them by merging the latest base branch into the task branch; do not rebase or cherry-pick.
- If you make code changes, run the relevant automated checks for the affected scope, then commit and push the task branch before returning `completed`.
- If nothing needs to be changed or replied to for the current PR state, return `no_action_needed` and include `review_checkpoint_eligible`.
- Resolve threads only when your code or reply truly addresses them.

{{fragment:output-schema}}
