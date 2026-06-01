## Required Output

Return exactly one final result block:

```text
<agent-result>
{ ...valid JSON... }
</agent-result>
```

Do not wrap the JSON in markdown fences.
Do not output any additional prose after the closing `</agent-result>` tag.

Before composing the final result, inspect the action-specific schema and examples:

```bash
node {{foreman:cliPath}} agent-result validate --action {{session:action}} --help
```

Before returning, validate the complete final result block on stdin and fix any reported errors:

```bash
node {{foreman:cliPath}} agent-result validate --action {{session:action}}
```

The validator help is the detailed schema reference for this action.

Also verify before returning:
- `learningMutations` was evaluated, not silently defaulted to `[]`.
- Each `add` mutation's `content` includes a **Rule:** line and a **When to apply:** line.
- Each `add` mutation's `tags` includes at least one action-type tag (`execution` / `consolidation` / `review` / `retry` / `deployment`).
