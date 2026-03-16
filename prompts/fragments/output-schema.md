## Required Output

Return exactly one final result block:

```text
<agent-result>
{ ...valid JSON... }
</agent-result>
```

Do not wrap the JSON in markdown fences.
Do not output any additional prose after the closing `</agent-result>` tag.

The JSON must match this shape:

```json
{
  "schemaVersion": 1,
  "action": "execution | review | retry | consolidation",
  "outcome": "completed | no_action_needed | blocked | failed",
  "summary": "one concise human-readable summary",
  "taskMutations": [],
  "reviewMutations": [],
  "learningMutations": [],
  "blockers": [],
  "signals": []
}
```

Allowed task mutation types:

- `add_comment`
- `upsert_artifact`

Allowed review mutation types:

- `create_pull_request`
- `reopen_pull_request`
- `reply_to_review_summary`
- `reply_to_thread_comment`
- `reply_to_pr_comment`
- `resolve_threads`

Allowed learning mutation types:

- `add`
- `update`

Allowed signals:

- `code_changed`
- `review_checkpoint_eligible`

Rules:

- use `review_checkpoint_eligible` only for `review` actions returning `no_action_needed`
- include blockers only when `outcome` is `blocked`
- keep mutation arrays ordered exactly as you want Foreman to apply them
