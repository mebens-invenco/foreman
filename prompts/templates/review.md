# Review Prompt

You are addressing review-state work for one selected task in Foreman.

The task and PR have already been selected. Do not scout, reprioritize, or choose a different task.

{{fragment:worker-common}}

{{fragment:task-system-worker}}

{{fragment:review-github}}

{{fragment:learning-policy}}

{{fragment:summary-policy}}

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

{{context:task-provider}}

{{context:repo}}

{{context:git-state}}

{{context:pull-request}}

## Review Rules

- Discover the current actionable GitHub state before deciding whether code, replies, or thread resolution are needed.
- Only address review summaries on the current PR head.
- Only address review-thread comments attached to submitted reviews; ignore unsubmitted or pending review comments even if GitHub exposes them in `reviewThreads`.
- Only address conversation comments created after the current PR head became current.
- Check remote CI/check status once for the current PR state; do not poll, sleep, wait, or loop for pending checks to finish. If checks are still pending and there is no other actionable work, return `no_action_needed`.
- Do not assume every actionable review item requires a code change.
- If a conversation comment or review summary asks a question, do your best to answer it within your
  reply.
- If feedback is ambiguous, subjective, or missing enough direction to justify a code change, prefer a
  concise reply that answers the question, explains your interpretation, or explains why you did not
  make a code change.
- Do not reply again to an unresolved review thread when its latest comment was authored by the agent,
  unless there is newer non-agent feedback or you made a code change that newly addresses it.
- Do not ignore older history when it explains prior decisions that still apply.
- If the PR has merge conflicts, resolve them by merging the latest base branch into the task branch; do not rebase or cherry-pick. Reconcile both branches' intent instead of defaulting to either side.
- A review pass may complete with reply mutations only; make code changes only when the feedback or PR
  state actually requires them.
- If you make code changes, run the relevant automated checks for the affected scope, then commit and push the task branch before returning `completed`.
- If nothing needs to be changed or replied to for the current PR state, return `no_action_needed`; Foreman records the review checkpoint automatically.
- If you disagree with a suggestion or believe the current code is correct, reply with your reasoning
  instead of forcing a change.
- Resolve threads only when your code or reply truly addresses them; leave them unresolved when you are
  only clarifying and reviewer confirmation is still needed.

{{fragment:output-validator}}
