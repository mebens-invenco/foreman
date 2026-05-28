## Linear Planning Rules

Produce tasks that can be created directly in Linear and executed later by Foreman.

- Use the workspace's configured execution label and consolidation label conventions.
- Do not apply the workspace's configured agent-created label to planned tasks unless those tasks are being created by a cron job that references this plan.
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
  Runner.execution.model: <model>
  Runner.execution.tuning: <low|medium|high|xhigh|max>
  Runner.reviewer.model: <model>
  Runner.reviewer.tuning: <low|medium|high|xhigh|max>
```

- Prefer a single repo in `Repos` unless the work truly spans multiple repos.
- Add `Repo dependencies` only when one repo target must wait on another repo target from the same task.
- `Repos` is required.
- `Base from task` is required when there is more than one task dependency.
- `Branch` is optional. Only use when overriding the default branch naming convention for the task system/executor is needed.
- Cross-task dependencies still belong in `Depends on tasks` and `Base from task`.
- `Runner.execution.*` / `Runner.reviewer.*` are optional per-task overrides on the workspace runner config. Use only when this task warrants a stronger or cheaper model than the workspace default. The shorthand `Runner.model` / `Runner.tuning` applies to the execution role. Provider type stays as configured in the workspace; only `model` and `tuning` can be overridden. `tuning` maps to the active provider's tuning knob (`effort` for Claude/Codex, `variant` for OpenCode).
- Omit dependency keys entirely when they are not needed.
