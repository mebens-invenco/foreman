## Linear Provider Access

The task system is Linear.

- `LINEAR_API_KEY` is available in the environment for Linear reads.
- Use the selected task identifier, provider issue id, and issue URL from `Task Provider Context` to query Linear directly.
- Query Linear GraphQL for the issue description, comments, labels, attachments, state, assignee, related issues, and linked pull requests when needed.
- Recommended Linear read pattern:

```bash
curl -sS https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"query":"query ForemanIssue($id: String!) { issue(id: $id) { id identifier title description url state { name } comments { nodes { id body createdAt user { name } } } attachments { nodes { id title url } } } }","variables":{"id":"<Task Provider Context.issueId>"}}'
```

- Let tools read `LINEAR_API_KEY` from the environment; do not print the token.
- Linear attachment and upload URLs may require the same authorization. When downloading Linear-hosted attachments, include `-H "Authorization: $LINEAR_API_KEY"` and do not print the token.
- Before reading a downloaded attachment as an image, verify the response is an actual image file, not JSON, HTML, or text. If the download returns an error payload, inspect the error and retry with the correct authorization instead of passing it to image-reading tools.
- Return all Linear writes as Foreman task mutations instead of calling write APIs directly.
