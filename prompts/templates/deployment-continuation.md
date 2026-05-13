Continue deployment tracking from the current deployment session.

Check deployment status once. Do not poll, sleep, wait, loop for rollout, make code changes, commit, push, or open pull requests. Return `in_progress` if rollout is still pending, `succeeded` only when deployment is verified, `follow_up_created` only with concrete regression evidence and a task creation mutation, and `blocked` when the deployment cannot be checked or the failure source is unclear.

{{fragment:output-validator}}
