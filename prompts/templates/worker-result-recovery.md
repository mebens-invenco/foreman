# Worker Result Recovery Prompt

Foreman needs to recover the missing worker result for task {{task:id}}: {{task:title}}

The previous {{session:action}} runner process exited 0, but Foreman could not parse a valid `<agent-result>` block from stdout.

{{context:parse-failure}}

Do not continue implementation, review, or make code changes. Inspect the existing worktree state only if needed.

Return exactly one valid `<agent-result>` block for action `{{session:action}}` and no prose after it.

If you cannot safely determine the completed result, return a valid result with outcome `failed`, no mutations, and a concise diagnostic summary.

Do not convert unvalidated prose into task or review mutations.

{{context:invalid-output}}

{{fragment:output-validator}}
