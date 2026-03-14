Return exactly one structured worker result. Preferred format:

```text
<agent-result>
{ ...valid JSON object... }
</agent-result>
```

The JSON object must match schema version `1`, include the current action, a safe outcome, a concise summary, and ordered mutations.
