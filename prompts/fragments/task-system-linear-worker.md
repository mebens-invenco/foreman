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
  --data '{"query":"query ForemanIssue($id: String!) { issue(id: $id) { id identifier title description url state { name } comments { nodes { id body createdAt user { name } } } } }","variables":{"id":"<Task Provider Context.issueId>"}}'
```

- Let tools read `LINEAR_API_KEY` from the environment; do not print the token.
- Return all Linear writes as Foreman task mutations instead of calling write APIs directly.
