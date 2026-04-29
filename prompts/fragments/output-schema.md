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
  "action": "execution | review | reviewer | retry | consolidation",
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

- `create_pull_request`
- `reopen_pull_request`
- `reply_to_review_summary`
- `reply_to_thread_comment`
- `reply_to_pr_comment`
- `submit_pull_request_review`
- `resolve_threads`

Review mutation field requirements:

- `create_pull_request` requires `title`, `body`, `draft`, `baseBranch`, and `headBranch`
- `reopen_pull_request` requires `draft` and at least one of `pullRequestUrl` or `pullRequestNumber`; `title` and `body` are optional
- `reply_to_review_summary` requires `reviewId` and `body`
- `reply_to_thread_comment` requires `threadId` and `body`
- `reply_to_pr_comment` requires `commentId` and `body`
- `submit_pull_request_review` requires `body`, `event`, and a `comments` array; each comment requires `path`, `line`, and `body`; `side` is optional and defaults to the changed side when omitted
- `resolve_threads` requires a non-empty `threadIds` array

Example `create_pull_request` mutation:

```json
{
  "type": "create_pull_request",
  "title": "ENG-4753: Upgrade default Node image to 24.14",
  "body": "## Summary\n- ...",
  "draft": true,
  "baseBranch": "<Repository Context.baseBranch>",
  "headBranch": "<Repository Context.selectedTarget.branchName>"
}
```

Allowed learning mutation types:

- `add`
- `update`

Learning mutation field requirements:

- `add` requires `title`, `repo`, `confidence`, `content`, and `tags`
- `repo` must be `shared` or the current repository key
- `confidence` must be one of `emerging`, `established`, or `proven`
- `tags` must be an array of strings; use `[]` when no compact tags apply
- `update` requires `id`; `title`, `repo`, `confidence`, `content`, `tags`, and `markApplied` are optional

Example `add` learning mutation:

```json
{
  "type": "add",
  "title": "Continuation prompts need bootstrap context after failed resume",
  "repo": "foreman",
  "confidence": "emerging",
  "content": "When a persisted native runner resume fails, rerender a bootstrap prompt before starting a fresh native session because continuation prompts assume prior context.",
  "tags": ["runner-sessions", "prompts"]
}
```

Blocker requirements:

- each blocker must be a non-empty string message

Example blocker:

```json
"A stable 46.x release of @invenco/common-interface must be published before this branch can be made merge-safe."
```

Allowed signals:

- `code_changed`
- `review_checkpoint_eligible`
- `reviewer_checkpoint_eligible`

Rules:

- use `review_checkpoint_eligible` only for `review` actions returning `no_action_needed`
- use `reviewer_checkpoint_eligible` only for `reviewer` actions returning `no_action_needed`
- include blockers only when `outcome` is `blocked`
- keep mutation arrays ordered exactly as you want Foreman to apply them
- before returning, verify that every mutation includes all fields required by its type; a missing required field causes the entire attempt to fail schema validation
