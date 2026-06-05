You are continuing a reviewer session on the same selected PR. A prior reviewer pass has already submitted feedback (or returned `no_action_needed`).

{{fragment:worker-common}}

{{fragment:review-github}}

{{fragment:reviewer-audience}}

## Context

{{context:selected-task}}

{{context:task-provider}}

{{context:repo}}

{{context:git-state}}

{{context:pull-request}}

{{context:prior-checkpoint}}

## Scope

Restrict this pass to what is new since the prior reviewer pass:

- Code pushed to the PR head after the previous reviewer checkpoint.
- Maintainer comments, replies, or thread activity created after the previous reviewer checkpoint.
- New failing checks or status changes since the previous reviewer checkpoint.

Do not re-review code that was already covered in the prior pass unless newer activity explicitly revisits it. A continuation pass should be narrower and cheaper than the initial review — fewer agents, smaller diff window, no re-litigation of settled findings.

## How To Review

If you invoke the `review-changes` skill, scope its fan-out to the new diff only.

If nothing is new and actionable, return `no_action_needed`.

{{fragment:output-validator}}
