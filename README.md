# Foreman

Foreman is a workspace-scoped orchestrator for agentic development work. It scouts task systems, selects executable tickets, runs implementation/review/deployment jobs against discovered git repos, and records the resulting artifacts.

## Quick Start: Set Up A Workspace

```bash
yarn install
yarn build
yarn foreman init <workspace> --task-system linear
# or: yarn foreman init <workspace> --task-system file
```

Initialization creates `workspaces/<workspace>/` with `foreman.workspace.yml`, `.env`, `foreman.db`, logs, artifacts, and worktrees. File-backed workspaces also get a `tasks/` directory.

Before serving:

- Fill in `workspaces/<workspace>/.env`: `GH_TOKEN` is used for GitHub review/PR context, `LINEAR_API_KEY` is required for Linear workspaces, and `GH_CONFIG_DIR` is optional.
- Edit `workspaces/<workspace>/foreman.workspace.yml`: configure `repos.explicit` or `repos.roots`, task states/labels, runners, scheduler concurrency, and the HTTP port if needed.
- Repos are discovered by basename, so ticket repo keys must match the discovered repo directory name.

Start Foreman with:

```bash
yarn foreman serve <workspace>
```

The UI and API are served on the configured HTTP host/port, defaulting to `http://127.0.0.1:8765`.

## Plan Tickets With `plan.md`

When you serve a workspace, Foreman writes `workspaces/<workspace>/plan.md` and a JSON context artifact under `workspaces/<workspace>/artifacts/`. Point a planning agent at that generated `plan.md`; it contains the workspace config, discovered repos, task-system-specific ticket rules, and instructions for using the learnings CLI before decomposing work.

The planner should return small, dependency-aware tickets that are ready for the active task system. For Linear, that means Linear issue content with the required `Agent:` metadata block. For file workspaces, that means markdown task files with YAML frontmatter.

## Ticket Metadata And Pass-Through Rules

For Linear-backed workspaces, Foreman reads ticket routing and dependency metadata from an `Agent:` block in the issue description:

```text
Agent:
  Repos: foreman
  Depends on tasks: ENG-123
  Base from task: ENG-123
  Repo dependencies: ui<-api
  Branch: task-branch-name
```

Use `Repos` on every executable ticket. Add `Depends on tasks`, `Base from task`, `Repo dependencies`, or `Branch` only when they are needed.

For file-backed workspaces, the same concepts live in YAML frontmatter. Each ticket is `workspaces/<workspace>/<tasksDir>/<id>.md`; by default, `tasksDir` is `tasks`. The frontmatter `id` must match the filename stem.

```yaml
---
id: TASK-0001
title: Add retry telemetry
state: ready
priority: normal
labels:
  - Agent
targets:
  - repoKey: foreman
    branchName: task-0001
    position: 0
targetDependencies: []
dependsOnTasks: []
baseFromTask: null
pullRequests: []
assignee: null
createdAt: 2026-05-13T00:00:00.000Z
updatedAt: 2026-05-13T00:00:00.000Z
---

Task body...
```

Tickets become Foreman candidates when they satisfy the task-system filter and metadata requirements:

- Linear tickets must be in the configured team, assigned to the configured assignee, and have one of `taskSystem.linear.includeLabels`.
- File tickets must be valid markdown task files in the configured task directory, with an `id` matching the filename.
- The ticket state must map to a configured Foreman state such as `ready`, `in_progress`, `in_review`, `deployable`, `done`, or `canceled`; unmapped states are skipped.
- Execution requires at least one target repo via `targets` or `Agent: Repos`, and every repo key must match a discovered repo.
- Dependencies must be schedulable: one dependency can be used as the base branch; multiple dependencies require `baseFromTask`; non-base dependencies must be merged or completed.
- `targetDependencies` or `Repo dependencies` are only needed for multi-repo tickets where one repo target must wait for another.

## Functionality Overview

- Scouts configured task systems and mirrors candidate tasks into the workspace SQLite database.
- Schedules execution, retry, review, reviewer, deployment, consolidation, and cron jobs up to configured worker concurrency.
- Creates isolated git worktrees for agent attempts and records prompts, logs, runner output, and result artifacts.
- Tracks GitHub pull requests, review comments, checks, merge state, and deployment follow-up work.
- Supports file and Linear task systems, GitHub review context, and `opencode`, `claude`, or `codex` runners.
- Exposes an HTTP UI/API while `foreman serve <workspace>` is running.

## Capping Claude Spend Per Attempt

For `claude` runner blocks (either `runner.execution` or `runner.reviewer`), set the optional `maxBudgetUsd` field to forward Claude's `--max-budget-usd <amount>` cap on every invocation:

```yaml
runner:
  execution:
    type: claude
    model: claude-opus-4-8
    effort: max
    timeoutMs: 3600000
    maxBudgetUsd: 100   # optional; omit to leave spend uncapped
  reviewer:
    type: claude
    model: claude-opus-4-8
    effort: high
    timeoutMs: 3600000
    maxBudgetUsd: 50
```

The cap is a **per-invocation** safety net, not an aggregate budget: each attempt and each reviewer run starts a fresh `claude` process with its own cap. The cap and `timeoutMs` are independent guards — whichever fires first terminates the run. Use it to bound runaway attempts; pick the value from observed normal spend plus headroom, not from cost-estimation rates. Omitting the field preserves current behavior (no cap).
