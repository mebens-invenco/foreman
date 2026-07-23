You are continuing a review session on the same selected PR. A prior review action has already addressed feedback (or returned `no_action_needed`).

{{fragment:worker-common}}

{{fragment:review-github}}
{{fragment:review-github-resolution}}

{{fragment:comment-brevity}}

{{fragment:summary-policy}}

## Context

{{context:selected-task}}

{{context:task-provider}}

{{context:repo}}

{{context:git-state}}

{{context:pull-request}}

{{context:relevant-learnings}}

{{context:prior-checkpoint}}

## Scope

Restrict this pass to what is new since the prior review action:

- Maintainer replies, new review threads, or new top-level comments created after the previous review checkpoint.
- Failing checks or merge conflicts that have appeared since the previous review checkpoint.
- Review summaries on the current PR head that were not present at the previous checkpoint.

Do not re-address feedback that was already handled in the prior pass unless newer activity explicitly revisits it. A continuation pass should be narrower and cheaper than the initial review action.

If you make code changes, run the relevant automated checks for the affected scope, then commit and push the task branch before returning `completed`. If nothing is new and actionable, return `no_action_needed`.

{{fragment:output-validator}}
