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
  "action": "{{session:action}}",
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

Allowed review mutation types:

- `reply_to_review_summary`
- `reply_to_thread_comment`
- `reply_to_pr_comment`
- `submit_pull_request_review`
- `resolve_threads`

Review mutation field requirements:

- `reply_to_review_summary` requires `reviewId` and `body`
- `reply_to_thread_comment` requires `threadId` and `body`
- `reply_to_pr_comment` requires `commentId` and `body`
- `submit_pull_request_review` requires `body`, `event`, and a `comments` array; each comment requires `path`, `line`, and `body`; `side` is optional and defaults to the changed side when omitted
- `resolve_threads` requires a non-empty `threadIds` array

Blocker requirements:

- each blocker must be a non-empty string message

Allowed signals:

- `code_changed`
- `review_checkpoint_eligible`
- `reviewer_checkpoint_eligible`

Rules:

- checkpoint signals are accepted for compatibility, but Foreman records no-op review checkpoints automatically
- include blockers only when `outcome` is `blocked`
- keep mutation arrays ordered exactly as you want Foreman to apply them
- before returning, verify that every mutation includes all fields required by its type
