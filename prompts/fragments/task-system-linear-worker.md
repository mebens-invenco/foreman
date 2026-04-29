## Linear Provider Access

The task system is Linear.

- `LINEAR_API_KEY` is available in the environment for Linear reads.
- Use the selected task identifier, provider issue id, and issue URL from `Task Provider Context` to query Linear directly.
- Query Linear GraphQL for the issue description, comments, labels, attachments, state, assignee, related issues, and linked pull requests when needed.
- Recommended Linear read pattern:

```bash
node --input-type=module <<'EOF'
const query = `query ForemanIssue($id: String!) { issue(id: $id) { id identifier title description url state { name } comments { nodes { id body createdAt user { name } } } } }`;
const response = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: { Authorization: process.env.LINEAR_API_KEY ?? "", "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables: { id: "<Task Provider Context.issueId>" } }),
});
console.log(JSON.stringify(await response.json(), null, 2));
EOF
```

- Let scripts read `LINEAR_API_KEY` from the environment; do not expand or print the token.
- Return all Linear writes as Foreman task mutations instead of calling write APIs directly.
