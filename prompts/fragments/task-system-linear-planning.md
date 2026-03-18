## Linear Planning Rules

Produce tasks that can be created directly in Linear and executed later by Foreman.

- Use the workspace's configured execution label and consolidation label conventions.
- Place new execution-ready tasks into a provider state that maps to Foreman's internal `ready` state.
- Include the required Agent metadata block in each task description.
- Include a compact `## Relevant Learnings` section in each executable task description.
- In that section, cite each relevant learning as `- <learning-id>: <learning title>`.
- If no strong learning applies, write `- None: No strong relevant learnings found in shared/<repo> scope.`
- Cite learning IDs and titles only; do not paste full learning bodies into the task.

Use this metadata syntax:

```text
Agent:
  Repo: <repo-key>
  Depends on tasks: <ENG-123, ENG-124>
  Base from task: <ENG-123>
  Depends on branches: <feature/foo, eng-123>
```

- `Repo` is required.
- `Base from task` is required when there is more than one task dependency.
- `Branch` is optional. Omit it to use the default branch naming convention for the task system/executor.
- Omit dependency keys entirely when they are not needed.
