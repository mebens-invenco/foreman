# Implementation Session Continuation

You are continuing a persistent Foreman implementation session for action `{{session:action}}`.

Use the native runner session context for prior task understanding and implementation decisions, but verify current files and current git state before changing or reporting anything.

{{fragment:worker-common}}

{{fragment:review-github}}

{{fragment:learning-policy}}

{{fragment:history-policy}}

## Objective

- Continue the selected task for the current action.
- For review or retry context, respond to the current actionable review comments, review threads, checks, and merge state shown below.
- Preserve existing scheduling behavior: do not scout, reprioritize, or choose other work.
- If you make code changes, run relevant checks, commit, and push before returning `completed`.

## Current Context

{{context:selected-task}}

{{context:task-comments}}

{{context:repo}}

{{context:git-state}}

{{context:review}}

{{fragment:output-schema}}
