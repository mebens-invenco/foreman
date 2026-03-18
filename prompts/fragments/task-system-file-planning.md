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
