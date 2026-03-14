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

Expected executable-task metadata fields:

- `repo`
- `branchName`
- `dependsOnTasks`
- `baseFromTask`
- `dependsOnBranches`
- `assignee`

Use normalized states only:

- `ready`
- `in_progress`
- `in_review`
- `done`
- `canceled`
