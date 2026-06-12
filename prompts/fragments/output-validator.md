## Required Output

Return exactly one final result block:

```text
<agent-result>
{ ...valid JSON... }
</agent-result>
```

Do not wrap the JSON in markdown fences.
Do not output any additional prose after the closing `</agent-result>` tag.

Before composing the final result, review the action-specific schema and example below.

**Schema for** `agent-result` **with** `action: {{session:action}}` — derived from the validator; any mismatch fails the final validate step below.

{{context:result-schema}}

Before returning, validate the complete final result block on stdin and fix any reported errors:

```bash
node {{foreman:cliPath}} agent-result validate --action {{session:action}}
```
