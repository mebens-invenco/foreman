# Review Continuation

You are continuing the existing persistent Foreman implementation session for this task.

Use prior native session context for background, but verify current files and current git state before acting.

Address only the current actionable review activity for the selected pull request. Use provider reads to rediscover current GitHub state before acting. If code changes are needed, run relevant checks, commit, and push before returning `completed`. If nothing remains to address, return `no_action_needed`.

{{fragment:worker-common}}

{{fragment:task-system-worker}}

{{fragment:review-github}}

{{context:selected-task}}

{{context:task-provider}}

{{context:repo}}

{{context:git-state}}

{{context:pull-request}}

{{fragment:output-schema}}
