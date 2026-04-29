## File Task Access

The task system is file-based.

- Read the task markdown file listed in `Task Provider Context` for the full task description and metadata.
- Read the comments NDJSON file listed in `Task Provider Context` when it exists.
- Treat the task file and comments file as read-only during worker execution.
- Return task notes as Foreman task mutations instead of editing task files directly.
