## File Task Planning Rules

Produce tasks that can be written directly into the workspace file task system.

Each task should map to one markdown file with YAML frontmatter.

Required frontmatter fields:

- `id`
- `title`
- `state`
- `priority`
- `labels`
- `artifacts`
- `createdAt`
- `updatedAt`

Expected executable-task frontmatter fields:

- `targets`
- `targetDependencies`
- `dependsOnTasks`
- `baseFromTask`
- `assignee`

Use this frontmatter shape for executable tasks:

```yaml
targets:
  - repoKey: <repo-key>
    branchName: <task-branch-name>
    position: 0
targetDependencies: []
```

- `targets` is required and should list repo targets in execution order.
- Prefer a single target unless the work truly spans multiple repos.
- Add `targetDependencies` only when one repo target must wait on another repo target from the same task.
- Omit dependency keys entirely when they are not needed.
- Legacy `repo` and `branchName` frontmatter is deprecated; use `targets` instead.

Each executable task body must also include a compact `## Relevant Learnings` section:

- cite each relevant learning as `- <learning-id>: <learning title>`
- if no strong learning applies, write `- None: No strong relevant learnings found in shared/<repo> scope.`
- cite learning IDs and titles only; do not paste full learning bodies into the task

Use normalized states only:

- `ready`
- `in_progress`
- `in_review`
- `done`
- `canceled`
