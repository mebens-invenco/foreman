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
  Repos: <repo-key[, repo-key]>
  Depends on tasks: <ENG-123, ENG-124>
  Base from task: <ENG-123>
  Repo dependencies: <repo-b<-repo-a>
  Branch: <task-branch-name>
```

- Prefer a single repo in `Repos` unless the work truly spans multiple repos.
- Add `Repo dependencies` only when one repo target must wait on another repo target from the same task.
- `Repos` is required.
- `Base from task` is required when there is more than one task dependency.
- `Branch` is optional. Only use when overriding the default branch naming convention for the task system/executor is needed.
- Cross-task dependencies still belong in `Depends on tasks` and `Base from task`.
- Omit dependency keys entirely when they are not needed.
