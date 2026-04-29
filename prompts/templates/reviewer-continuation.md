# Reviewer Continuation

You are continuing the existing persistent Foreman reviewer session for this pull request.

Use prior native session context for settled reviewer decisions, but review the current files and current git state directly. Use provider reads to rediscover current GitHub state before deciding whether to leave review feedback.

{{fragment:worker-common}}

{{fragment:task-system-worker}}

{{fragment:review-github}}

{{context:selected-task}}

{{context:task-provider}}

{{context:repo}}

{{context:git-state}}

{{context:provider-access}}

{{context:pull-request}}

{{fragment:output-schema}}
