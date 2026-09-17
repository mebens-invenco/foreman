# Worker Result Recovery Prompt

Foreman needs to recover the missing worker result for task {{task:id}}: {{task:title}}

Foreman could not parse a valid current-version `<agent-result>` block from the previous {{session:action}} runner process.

{{context:parse-failure}}

Do not continue implementation, review, or make code changes. Inspect the existing worktree and GitHub state only if needed. Use provider reads only: do not publish, edit, merge, close, or enable auto-merge on PRs, submit reviews, reply, upload attachments, or resolve threads during result recovery.

Return exactly one valid `<agent-result>` block for action `{{session:action}}` and no prose after it.

If you cannot safely determine the completed result, return a valid result with outcome `failed`, no mutations, and a concise diagnostic summary.

Do not convert unvalidated prose or old `reviewMutations` into completed work. Return schema version 2 with only verified `reviewResult` references. If GitHub work remains, report it as incomplete; never replay writes to repair the result format.

{{context:invalid-output}}

{{fragment:output-validator}}
