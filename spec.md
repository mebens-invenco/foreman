# Foreman Spec

## Overview

Foreman is a new workspace-scoped orchestration system for autonomous software work.

Foreman is built around:

- a code-only Scout,
- a lease-based scheduler,
- a pool of in-process workers,
- a pluggable task system,
- a GitHub-backed review service,
- an abstract agent runner,
- a built-in HTTP API and SSE streams,
- and a workspace-local SQLite database for operational state, learnings, and history.

Foreman is intended to be implemented from scratch in a new folder. It is a standalone system with its own runtime model, storage layout, prompt system, and HTTP API. The only data assumed to be carried forward is previously captured learnings/history SQLite data, imported once into a new workspace database.

## Goals

- Make Scout deterministic, fast, and code-owned.
- Keep tasks provider-backed as the only source of truth.
- Support multiple task systems behind one interface.
- Keep GitHub review support strong, even if fully generic review abstraction is deferred.
- Support multiple workspace-local auth contexts.
- Keep prompts owned by the Foreman codebase, not workspaces.
- Preserve operator visibility through HTTP APIs, logs, and Scout/attempt history.

## Non-Goals For V1

- No webhook dependency for Linear, GitHub, or file tasks.
- No filesystem watching.
- No persistent task snapshot cache in the database.
- No generic multi-provider review abstraction beyond GitHub-first support.
- No Prisma.
- No DB admin commands beyond automatic migration and a separate one-off legacy import command.

## Naming

- Program name: `foreman`
- Example CLI: `foreman serve foo`
- Workspace config file: `foreman.workspace.yml`
- Workspace DB file: `foreman.db`

## Technology

- Language: TypeScript
- Runtime: Node.js
- Package manager: Yarn
- DB: SQLite via `better-sqlite3`
- Validation: `zod`
- HTTP server: Fastify
- Migrations: forward-only SQL files with a small TypeScript runner

## Workspace Model

Foreman runs one process per workspace.

Workspaces live under a gitignored `workspaces/` directory inside the Foreman repo.

Example layout:

```text
<foreman-root>/
  workspaces/
    foo/
      foreman.workspace.yml
      .env
      plan.md
      foreman.db
      logs/
      artifacts/
      worktrees/
      tasks/
```

`tasks/` is only used when the workspace task system is `file`.

## Process Model

One `foreman serve <workspace>` process owns all runtime behavior for that workspace:

- HTTP server
- scheduler
- Scout coordinator
- worker pool
- SSE streams

Default worker concurrency is `4`.

Workers are logical in-process worker slots. Each worker may spawn a child process through the agent runner. The child process is not responsible for scheduler heartbeats.

## CLI

### Main Commands

- `foreman init <workspace> --task-system <linear|file>`
- `foreman serve <workspace>`
- `foreman plan prompt <workspace>`
- `foreman scheduler start <workspace>`
- `foreman scheduler pause <workspace>`
- `foreman scheduler stop <workspace>`
- `foreman db import-legacy <workspace> <legacy-memory.db>`

### Command Behavior

`foreman init <workspace> --task-system <linear|file>`:

- resolves `<workspace>` to `<foreman-root>/workspaces/<workspace>`
- fails if the target workspace directory already exists and is non-empty
- creates the workspace directory structure
- creates `foreman.workspace.yml`
- creates `.env`
- creates `foreman.db`
- creates `logs/`, `artifacts/`, and `worktrees/`
- creates `tasks/` when `--task-system file` is selected
- initializes `foreman.db` by applying migrations only
- does not import legacy data
- does not start the server
- does not generate `plan.md`

`foreman serve <workspace>`:

- resolves `<workspace>` to `<foreman-root>/workspaces/<workspace>`
- loads `foreman.workspace.yml`
- loads workspace `.env`
- validates integrations and config
- discovers repos
- runs DB migrations
- renders and overwrites `plan.md`
- writes planning JSON artifact
- starts HTTP server
- auto-starts scheduler

After successful initialization, Foreman should print next steps:

1. fill in `.env`
2. edit `foreman.workspace.yml`
3. run `foreman serve <workspace>`

`foreman plan prompt <workspace>`:

- renders the planning prompt for the workspace
- overwrites workspace `plan.md`
- writes the planning context JSON artifact

`foreman scheduler start|pause|stop <workspace>`:

- communicates with the running `foreman serve` process over local HTTP

Scheduler control semantics:

- `start`
  - starts or resumes scheduling
  - preserves queued jobs
  - does not interrupt running attempts
- `pause`
  - stops Scout and stops leasing or queueing new jobs
  - allows already running attempts to continue until they finish or fail
  - preserves queued jobs without canceling them
- `stop`
  - stops Scout and stops leasing or queueing new jobs
  - kills all running attempts
  - releases their active leases
  - preserves queued jobs unless they are explicitly canceled by a later operator action

`foreman db import-legacy <workspace> <legacy-memory.db>`:

- is a separate one-off command
- is never run automatically by `serve`

## Workspace Config Schema

Workspace configuration lives in `foreman.workspace.yml`.

`foreman init` writes a minimal valid config for the selected task system with default values from this spec. `foreman serve` assumes the workspace has already been initialized.

```yaml
version: 1

workspace:
  name: foo
  agentPrefix: "[agent] "

repos:
  explicit:
    - "../special-repo"
  roots:
    - "../repos"
  ignore:
    - "**/node_modules/**"
    - "**/.git/**"

taskSystem:
  type: linear

  linear:
    team: Engineering
    assignee: me
    includeLabels: [Agent]
    consolidatedLabel: "Agent Consolidated"
    states:
      ready: [Todo, Ready]
      inProgress: ["In Progress"]
      inReview: ["In Review"]
      done: [Done]
      canceled: [Canceled]

  file:
    tasksDir: tasks
    idPrefix: TASK
    states:
      ready: [ready]
      inProgress: [in_progress]
      inReview: [in_review]
      done: [done]
      canceled: [canceled]

reviewSystem:
  type: github

runner:
  type: opencode
  model: openai/gpt-5.4
  variant: high
  timeoutMs: 3600000

scheduler:
  workerConcurrency: 4
  scoutPollIntervalSeconds: 60
  scoutRerunDebounceMs: 1000
  leaseTtlSeconds: 120
  workerHeartbeatSeconds: 15
  staleLeaseReapIntervalSeconds: 15
  schedulerLoopIntervalMs: 1000
  shutdownGracePeriodSeconds: 10

http:
  host: 127.0.0.1
  port: 8765
```

### Validation Rules

- exactly one task system per workspace
- `taskSystem.type` must match the configured task system block
- `reviewSystem.type` must be `github` in v1
- `runner.type` must be `opencode` in v1
- `repos.explicit` entries must resolve to git repos
- `repos.roots` entries must exist
- `workspace.agentPrefix` must be non-empty
- all configured Linear states and labels must exist exactly or scheduler startup fails

## Auth

Per-workspace auth lives in the workspace `.env`.

Expected variables:

- `LINEAR_API_KEY` when using the Linear task system
- `GH_TOKEN` preferred for GitHub
- `GH_CONFIG_DIR` supported as fallback

Workspace `.env` is used only for orchestrator/provider auth. Repo-local `.env` loading is a separate execution concern.

## Repo Discovery And Resolution

### Discovery

Foreman supports both explicit repos and root-based repo discovery.

- `repos.explicit`
  - each path must be a git repo
  - may live outside the workspace
- `repos.roots`
  - may live outside the workspace
  - inspect only direct child directories of each root
  - if a direct child is a git repo, include it
  - if the root itself is a git repo, include it
  - do not recurse deeper than one level below the root

The final repo set is the union of explicit repos and root-discovered repos, deduped by resolved absolute path.

### Canonical Repo Key

The canonical repo key is the basename of the repo directory.

Examples:

- `/src/product-app` -> `product-app`
- `/src/shared-lib` -> `shared-lib`

### Resolution Rules

- task metadata `repo` must exactly match a discovered canonical repo key
- no aliasing, fuzzy matching, or path matching in v1
- if multiple repos have the same basename, startup fails
- if a selected task is missing a valid repo, the action is blocked and a task comment is added

## Task System Contract

The task system is the only source of truth for tasks and task states.

Foreman re-fetches provider truth every Scout cycle. Foreman does not persist a task snapshot cache in `foreman.db` in v1.

### Normalized Task States

- `ready`
- `in_progress`
- `in_review`
- `done`
- `canceled`

### Normalized Priority Values

- `urgent`
- `high`
- `normal`
- `none`
- `low`

### Normalized Task Shape

```ts
type Task = {
  id: string
  provider: "linear" | "file"
  providerId: string
  title: string
  description: string
  state: "ready" | "in_progress" | "in_review" | "done" | "canceled"
  providerState: string
  priority: "urgent" | "high" | "normal" | "none" | "low"
  labels: string[]
  assignee: string | null
  repo: string | null
  branchName: string | null
  dependencies: {
    taskIds: string[]
    baseTaskId: string | null
    branchNames: string[]
  }
  artifacts: TaskArtifact[]
  updatedAt: string
  url: string | null
}

type TaskArtifact = {
  type: "pull_request" | "commit" | "doc" | "link" | "other"
  url: string
  title?: string
  externalId?: string
}
```

### Task Comment Shape

```ts
type TaskComment = {
  id: string
  taskId: string
  body: string
  authorName: string | null
  authorKind: "agent" | "human" | "system" | "unknown"
  createdAt: string
  updatedAt: string | null
}
```

### TaskSystem Interface

```ts
interface TaskSystem {
  getProvider(): "linear" | "file"
  listCandidates(): Promise<Task[]>
  getTask(taskId: string): Promise<Task>
  listComments(taskId: string): Promise<TaskComment[]>
  addComment(input: { taskId: string; body: string }): Promise<void>
  transition(input: { taskId: string; toState: Task["state"] }): Promise<void>
  addArtifact(input: { taskId: string; artifact: TaskArtifact }): Promise<void>
  updateLabels(input: { taskId: string; add: string[]; remove: string[] }): Promise<void>
}
```

### Adapter Responsibilities

- parse provider-native metadata into normalized fields
- map provider-native states into normalized internal states
- return terminal tasks for consolidation candidates
- support comments uniformly across providers
- apply state transitions idempotently

## Linear Task System

### Default Candidate Filter

- assigned to `me`
- includes label `Agent`

### Consolidation Label

- keep `Agent Consolidated`

### State Mapping

Linear supports multiple provider states mapping into internal `ready`.

Default mapping:

- `ready`: `Todo`, `Ready`
- `in_progress`: `In Progress`
- `in_review`: `In Review`
- `done`: `Done`
- `canceled`: `Canceled`

### Metadata

Execution metadata is parsed from the task description. Required execution metadata includes `repo`. Optional metadata includes task dependencies, base task, branch dependencies, and branch name.

The metadata block syntax is:

```text
Agent:
  Repo: <repo-key>
  Depends on tasks: <ENG-123, ENG-124>
  Base from task: <ENG-123>
  Depends on branches: <feature/foo, eng-123>
  Branch: <task-branch-name>
```

Parsing rules:

- keys are case-insensitive
- `Repo` is required for `execution`, `review`, and `retry`
- `Depends on tasks` is an optional comma-separated list
- `Depends on branches` is an optional comma-separated list
- `Base from task` is required when `Depends on tasks` contains more than one task
- `Base from task` must be one of the listed task dependencies when present
- `Branch` is optional and, when present, is the preferred task branch name
- unknown keys are ignored

If `Branch` is omitted, the default task branch name is the lowercase task id.

### Base And Dependency Resolution

Foreman resolves `base_branch` deterministically before scheduling execution-like work.

Rules:

1. no task dependencies -> use the repo default branch
2. exactly one task dependency:
   - if the dependency is terminal, use the repo default branch
   - otherwise resolve the dependency branch in this order:
     1. latest open linked PR head branch for that dependency task
     2. dependency task `branchName`
     3. lowercase dependency task id
3. more than one task dependency:
   - require valid `Base from task`
   - all non-base task dependencies must be terminal
   - if the selected base task is terminal, use the repo default branch
   - otherwise resolve the selected base branch in this order:
     1. latest open linked PR head branch for the base task
     2. base task `branchName`
     3. lowercase base task id

Branch dependency rules:

- branch dependencies are repo-local only
- a branch dependency is satisfied only when the branch exists on origin and its tip is an ancestor of the resolved base branch tip
- if a required dependency branch does not exist on origin, the dependency is unsatisfied

If required metadata is missing or invalid for a task that would otherwise be selected, Foreman must add a task comment describing the blocker and not schedule that action.

## File Task System

### Layout

```text
tasks/
  TASK-0001.md
  TASK-0001.comments.ndjson
  TASK-0002.md
```

### Task File Format

Each task is a Markdown file with YAML frontmatter.

```md
---
id: TASK-0001
title: Add dashboard filtering
state: ready
priority: normal
labels:
  - Agent
repo: product-app
branchName: task-0001
dependsOnTasks: []
baseFromTask: null
dependsOnBranches: []
artifacts: []
assignee: null
createdAt: 2026-03-14T12:00:00Z
updatedAt: 2026-03-14T12:00:00Z
---

Implement dashboard filtering for status and owner.
```

### Comment File Format

Each file-backed task may have a sidecar comments file.

`TASK-0001.comments.ndjson`

Each line is a JSON object:

```json
{"id":"cmt_01","taskId":"TASK-0001","body":"[agent] blocked on missing repo metadata","authorName":"agent","authorKind":"agent","createdAt":"2026-03-14T12:30:00Z","updatedAt":null}
```

### ID Generation

- IDs are sequential per workspace
- format: `<PREFIX>-<4 digit zero-padded number>`
- default prefix: `TASK`

### File Task Rules

- `id` in frontmatter must match the filename stem
- writes to task Markdown files are atomic rewrite operations
- comment files are append-only
- frontmatter should be serialized in stable key order
- file comment ids should be generated as ULIDs
- if `branchName` is omitted, the default task branch name is the lowercase task id

## Worktrees

Foreman uses dedicated task worktrees for code-changing actions.

Rules:

- worktree root: `worktrees/<repo-key>/<task-id>/`
- never develop in the main repo checkout
- one task maps to one canonical worktree path
- reuse an existing task worktree if it already exists, whether clean or dirty
- if an existing worktree points at the wrong branch or wrong task context, treat that as a blocker
- `execution`, `review`, and `retry` all operate in the task worktree
- `retry` must reset the task branch state in the existing task worktree back to the resolved base branch plus a fresh task branch tip, and must not reuse prior patch content from the failed attempt
- `retry` may reuse prior review context, linked PR context, and task comments only
- cleanup happens only during `consolidation` or future explicit maintenance flows
- only remove a worktree if it is clean
- `in_progress` tasks without an active lease resume using the existing task worktree when present

## Review System

Foreman uses a GitHub-first review service in v1.

Responsibilities:

- resolve linked PRs from task artifacts
- fetch current PR state
- fetch review threads
- fetch top-level review summaries
- fetch top-level PR conversation comments
- fetch checks and merge state
- create/reopen PRs
- reply to review summaries and PR comments
- resolve threads

Foreman does not attempt a fully generic multi-provider review abstraction in v1.

### ReviewContext

```ts
type ReviewContext = {
  provider: "github"
  pullRequestUrl: string
  pullRequestNumber: number
  state: "open" | "closed" | "merged"
  isDraft: boolean
  headSha: string
  headBranch: string
  baseBranch: string
  headIntroducedAt: string
  mergeState: "clean" | "conflicting" | "dirty" | "unknown"
  actionableReviewSummaries: ReviewSummary[]
  actionableConversationComments: ConversationComment[]
  unresolvedThreads: ReviewThread[]
  failingChecks: CheckState[]
  pendingChecks: CheckState[]
}

type ReviewSummary = {
  id: string
  body: string
  authorName: string | null
  createdAt: string
  commitId: string
}

type ConversationComment = {
  id: string
  body: string
  authorName: string | null
  createdAt: string
}

type ReviewThread = {
  id: string
  path: string | null
  line: number | null
  isResolved: boolean
}

type CheckState = {
  name: string
  state: "pending" | "failure"
}
```

Review filtering rules:

- actionable review summaries are top-level review summaries whose `commitId` equals the current PR `headSha`, excluding empty bodies and bodies prefixed with `workspace.agentPrefix`
- actionable conversation comments are top-level PR conversation comments created after `headIntroducedAt`, excluding empty bodies and bodies prefixed with `workspace.agentPrefix`
- unresolved threads are file/line review threads where `isResolved == false`
- checks fingerprinting only considers failing and pending checks

## Agent Runner

`AgentRunner` abstracts only process invocation.

It does not assemble prompts or interpret result schemas.

### Interface

```ts
interface AgentRunner {
  invoke(request: AgentRunRequest): Promise<AgentRunResult>
}

type AgentRunRequest = {
  attemptId: string
  cwd: string
  env: Record<string, string>
  prompt: string
  timeoutMs: number
}

type AgentRunResult = {
  exitCode: number | null
  signal: string | null
  startedAt: string
  finishedAt: string
  stdoutBytes: number
  stderrBytes: number
}
```

The first implementation is `OpenCodeRunner`.

### Timeout

`runner.timeoutMs` is a hard wall-clock timeout for the total child process runtime.

Default: `3600000` (`1h`).

### Logging

- the worker spawns the runner child process
- the parent worker captures stdout/stderr
- logs are written to `logs/attempts/<attempt-id>.log`
- the parent worker owns heartbeat updates; the child process does not

## Prompt System

Prompts are stored in the Foreman codebase, not in workspaces.

### Sources

Templates:

- `prompts/templates/plan.md`
- `prompts/templates/execution.md`
- `prompts/templates/review.md`
- `prompts/templates/retry.md`
- `prompts/templates/consolidation.md`

Fragments:

- `prompts/fragments/worker-common.md`
- `prompts/fragments/task-system-linear-planning.md`
- `prompts/fragments/task-system-file-planning.md`
- `prompts/fragments/review-github.md`
- `prompts/fragments/output-schema.md`
- `prompts/fragments/learning-policy.md`
- `prompts/fragments/history-policy.md`

`templates/plan.md` contains its own shared planning guidance directly and includes the task-system-specific planning fragment.

Worker prompts use one shared runtime fragment for all task systems. Task-system-specific worker runtime fragments are intentionally not used in v1 because Foreman provides normalized task, comment, artifact, repo, and review context directly to the worker.

### Rendering Rules

- templates contain real content of their own
- fragments are inserted where reuse or provider variability exists
- prompts are rendered from live provider data and workspace config
- repo-root `AGENTS.md` or `CLAUDE.md` content is embedded directly in the rendered worker prompt

Repo instruction resolution rules:

- search only in the worktree root directory
- if both `AGENTS.md` and `CLAUDE.md` exist in the worktree root, prefer `AGENTS.md`
- if neither file is found in the worktree root, embed no repo-local instruction file

### Planning Prompt

On every `foreman serve`, Foreman must:

- render a current workspace-specific planning prompt
- overwrite `<workspace>/plan.md`
- write a planning context JSON artifact

### Worker Prompt Context

Worker prompts are rendered from:

- selected action
- normalized task
- task comments
- repo context
- worktree path
- resolved base branch
- embedded repo-local instructions
- review context when relevant
- exact output schema instructions

## Worker Result Schema

Workers return one structured result.

### Format

Preferred output format:

```text
<agent-result>
{ ...valid JSON object... }
</agent-result>
```

Parser behavior:

1. if stdout is pure JSON, accept it
2. otherwise parse exactly one `<agent-result>` block
3. otherwise fail parsing

### Shape

```ts
type WorkerResult = {
  schemaVersion: 1
  action: "execution" | "review" | "retry" | "consolidation"
  outcome: "completed" | "no_action_needed" | "blocked" | "failed"
  summary: string
  taskMutations: TaskMutation[]
  reviewMutations: ReviewMutation[]
  learningMutations: LearningMutation[]
  blockers: Blocker[]
  signals: Signal[]
}
```

### Signals

```ts
type Signal =
  | "code_changed"
  | "review_checkpoint_eligible"
```

### Task Mutations

```ts
type TaskMutation =
  | { type: "add_comment"; body: string }
  | {
      type: "upsert_artifact"
      artifact: {
        type: "pull_request" | "commit" | "doc" | "link" | "other"
        url: string
        title?: string
        externalId?: string
      }
    }
```

Task artifact upsert identity is `(type, url)` within a task. If an existing artifact has the same `type` and `url`, adapter code must update its optional metadata (`title`, `externalId`) rather than appending a duplicate.

### Review Mutations

```ts
type ReviewMutation =
  | {
      type: "create_pull_request"
      title: string
      body: string
      draft: boolean
      baseBranch: string
      headBranch: string
    }
  | {
      type: "reopen_pull_request"
      pullRequestUrl?: string
      pullRequestNumber?: number
      draft: boolean
      title?: string
      body?: string
    }
  | { type: "reply_to_review_summary"; reviewId: string; body: string }
  | { type: "reply_to_pr_comment"; commentId: string; body: string }
  | { type: "resolve_threads"; threadIds: string[] }
```

### Learning Mutations

```ts
type LearningMutation =
  | {
      type: "add"
      title: string
      repo: string
      confidence: "emerging" | "established" | "proven"
      content: string
      tags: string[]
    }
  | {
      type: "update"
      id: string
      title?: string
      repo?: string
      confidence?: "emerging" | "established" | "proven"
      content?: string
      tags?: string[]
      markApplied?: boolean
    }
```

`update.content` replaces the entire stored learning content. `update.tags` replaces the full tag set if provided.

### Blockers

```ts
type Blocker = {
  code: string
  message: string
}
```

### Outcome Semantics

- `completed`: action succeeded
- `no_action_needed`: valid no-op, mainly for review
- `blocked`: action could not proceed safely
- `failed`: unexpected task-level failure

Foreman uses the single `summary` field both for attempt display and for the history entry.

## Mutation Application Order

After a valid worker result:

1. validate schema
2. record parsed result artifact and attempt event
3. if `failed`, stop and mark attempt failed
4. if `blocked`, apply blocker comments first, then finalize as blocked
5. apply review mutations that create or reopen the PR
6. apply task artifact upserts for PR links
7. perform system-owned task transition to `in_review` when PR creation/reopen succeeded
8. apply remaining review mutations
9. apply remaining task mutations in listed order, unchanged
10. apply learning mutations
11. write history entry using `summary`
12. if eligible, write or update `review_checkpoint`
13. finalize attempt/job status
14. trigger local Scout rerun event

Failure handling:

- task/review mutation failure: blocking
- learning/history failure: blocking
- review checkpoint failure: non-fatal warning

Mutation failure stopping rule:

- stop applying mutations immediately after the first blocking failure
- record an `execution_attempt_event` describing the failure
- do not apply later mutations, history writes, or checkpoints after a blocking failure
- do not attempt rollback or compensation in v1

## Scout

Scout is fully deterministic and code-only.

### Candidate Scope

Each Scout pass fetches the full configured candidate set from the task system and partitions it into:

- active candidates
- terminal candidates

Active candidates include:

- `ready`
- `in_review`
- `in_progress` without an active lease

Terminal candidates include:

- `done`
- `canceled`

### Global Action Selection Order

When Scout fills available capacity, it evaluates actions in this global order:

1. `review`
2. `retry`
3. `execution`
4. `consolidation`

Within each action class, the more specific ordering rules below apply.

### Queue Fill Behavior

One Scout pass may enqueue multiple jobs, but only up to currently available capacity.

Available capacity is:

`workerConcurrency - active job count`

where active jobs are those in `queued`, `leased`, or `running` state.

Scout must repeatedly apply the same action-selection rules to the current candidate set until:

- available capacity is exhausted, or
- no further actionable candidate exists.

Scout must not create speculative deep backlog beyond currently available capacity, because queued jobs may become stale while other work is still running.

### Job Dedupe Behavior

- job `dedupe_key` is `<task_id>:<action>`
- Scout must not create a new job when another job with the same `dedupe_key` already exists in `queued`, `leased`, or `running` state
- once a job is terminal (`completed`, `failed`, `blocked`, or `canceled`), Scout may create a new job with the same `dedupe_key` in a later pass if the task is still actionable

### Comment Noise Filter

Scout ignores comments that are:

- empty
- prefixed with `workspace.agentPrefix`

Everything else is treated as potentially actionable.

### Review Action Ordering

Pick the first matching review action in this order:

1. unresolved review threads
2. actionable top-level review summaries on the current PR head
3. actionable top-level PR conversation comments after the current PR head
4. failing checks
5. merge conflicts

### Retry Rule

`retry` is eligible when:

- task is in review
- linked PR is closed and unmerged
- task is not terminal
- no explicit stop-intent is present

Stop intent is evaluated only from:

- PR top-level conversation comments
- task comments

Ignore:

- review summaries
- review threads
- bot comments
- comments with the configured agent prefix
- empty comments

Stop phrases, case-insensitive:

- `abandon`
- `do not continue`
- `do not retry`

If any task or PR comment contains one of those phrases, stop intent wins and Foreman must not retry.

### Execution Rule

Execution candidates are ranked in this order:

1. internal `ready`
2. internal `in_progress` with no active lease

Within those candidates, priority ranks are:

1. urgent
2. high
3. normal
4. none
5. low

Tie-breakers:

1. `ready` before resumable `in_progress`
2. older `updatedAt` first
3. lower numeric task id first

### Consolidation Rule

`consolidation` is eligible only when:

- no higher-priority action was selected
- task is terminal
- all PRs linked directly on the task are closed
- task still has the `Agent` label

Consolidation swaps labels:

- remove `Agent`
- add `Agent Consolidated`

### System-Owned State Transitions

- `execution` start -> `in_progress`
- `retry` start -> `in_progress`
- PR created/reopened -> `in_review`
- `review` remains `in_review`
- `consolidation` changes labels only

Task adapters are responsible for mapping these normalized states to provider-native states such as `In Progress` and `In Review`.

## Review Checkpoint Suppression

`review_checkpoint` prevents repeated no-op review work for unchanged PR state.

Write or update a checkpoint only when:

- action is `review`
- outcome is `no_action_needed`
- signal array contains `review_checkpoint_eligible`

Checkpoint match requires:

- same task id
- same linked PR
- same `head_sha`
- same latest actionable review summary id on the current head
- same latest actionable top-level PR conversation comment id after the current head
- same checks fingerprint
- same merge state

If Scout sees a checkpoint that no longer matches live PR state, it must prune the checkpoint immediately and continue normal review evaluation.

## Scout Scheduling And Timing

### Defaults

- `workerConcurrency`: `4`
- `scoutPollIntervalSeconds`: `60`
- `scoutRerunDebounceMs`: `1000`
- `leaseTtlSeconds`: `120`
- `workerHeartbeatSeconds`: `15`
- `staleLeaseReapIntervalSeconds`: `15`
- `schedulerLoopIntervalMs`: `1000`
- `shutdownGracePeriodSeconds`: `10`

### Trigger Model

Scout runs:

- immediately when scheduler starts
- on periodic poll
- after meaningful local events

Local events include:

- worker finished
- task mutation applied
- lease/job state changed materially

Event-triggered Scout runs reset the poll timer.

Only one Scout run may execute at a time. Burst triggers are coalesced into one follow-up rerun.

### Lease Recovery

Worker heartbeat updates both:

- `worker.last_heartbeat_at`
- all active leases owned by that worker/attempt

If a lease expires, Foreman does not create a replacement job directly. It waits for Scout to rerun against fresh provider truth and decide what to do next.

### Lease Acquisition Rules

Foreman uses leases for `job`, `task`, and `branch` resources in v1. It does not lease entire repos.

Lease sets by action:

- `execution`: `job`, `task`, `branch`
- `review`: `job`, `task`, `branch`
- `retry`: `job`, `task`, `branch`
- `consolidation`: `job`, `task`

Branch lease key format is `<repo-key>:<branch-name>`.

`branch-name` resolves from the task `branchName` when present, otherwise from the lowercase task id.

## Database

Each workspace has its own `foreman.db`.

### Core Tables

- `job`
- `execution_attempt`
- `execution_attempt_event`
- `lease`
- `worker`
- `artifact`
- `scout_run`
- `review_checkpoint`
- `learning`
- `history_step`
- `history_step_repo`

`job_dependency` may be added if needed later.

### Table Purposes

- `job`: durable selected unit of work
- `execution_attempt`: one worker run of a job
- `execution_attempt_event`: append-only lifecycle trail
- `lease`: exclusivity for jobs/tasks/branches
- `worker`: worker identity/status/heartbeat
- `artifact`: logs, prompts, results, planning artifacts
- `scout_run`: one high-level record per Scout pass
- `review_checkpoint`: no-op review suppression
- `learning`, `history_step`, `history_step_repo`: semantic memory/history

### Suggested SQL Shapes

#### job

```sql
id TEXT PRIMARY KEY,
task_id TEXT NOT NULL,
task_provider TEXT NOT NULL CHECK (task_provider IN ('linear', 'file')),
action TEXT NOT NULL CHECK (action IN ('execution', 'review', 'retry', 'consolidation')),
status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'blocked', 'canceled')),
priority_rank INTEGER NOT NULL CHECK (priority_rank >= 1 AND priority_rank <= 5),
repo_key TEXT NOT NULL,
base_branch TEXT,
dedupe_key TEXT NOT NULL,
selection_reason TEXT NOT NULL DEFAULT '',
selection_context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(selection_context_json)),
scout_run_id TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL,
leased_at TEXT,
started_at TEXT,
finished_at TEXT,
error_message TEXT
```

#### execution_attempt

```sql
id TEXT PRIMARY KEY,
job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
worker_id TEXT REFERENCES worker(id) ON DELETE SET NULL,
attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
runner_name TEXT NOT NULL CHECK (runner_name IN ('opencode')),
runner_model TEXT NOT NULL,
runner_variant TEXT NOT NULL,
status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'canceled', 'timed_out')),
started_at TEXT NOT NULL,
finished_at TEXT,
exit_code INTEGER,
signal TEXT,
summary TEXT NOT NULL DEFAULT '',
error_message TEXT
```

#### execution_attempt_event

```sql
id TEXT PRIMARY KEY,
execution_attempt_id TEXT NOT NULL REFERENCES execution_attempt(id) ON DELETE CASCADE,
event_type TEXT NOT NULL,
message TEXT NOT NULL DEFAULT '',
payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
created_at TEXT NOT NULL
```

#### lease

```sql
id TEXT PRIMARY KEY,
resource_type TEXT NOT NULL CHECK (resource_type IN ('job', 'task', 'branch')),
resource_key TEXT NOT NULL,
worker_id TEXT NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
execution_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL,
acquired_at TEXT NOT NULL,
heartbeat_at TEXT NOT NULL,
expires_at TEXT NOT NULL,
released_at TEXT,
release_reason TEXT
```

#### worker

```sql
id TEXT PRIMARY KEY,
slot INTEGER NOT NULL,
status TEXT NOT NULL CHECK (status IN ('idle', 'leased', 'running', 'stopping', 'offline')),
process_id INTEGER,
current_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL,
started_at TEXT NOT NULL,
last_heartbeat_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### artifact

```sql
id TEXT PRIMARY KEY,
owner_type TEXT NOT NULL CHECK (owner_type IN ('workspace', 'job', 'execution_attempt', 'scout_run')),
owner_id TEXT NOT NULL,
artifact_type TEXT NOT NULL CHECK (
  artifact_type IN ('log', 'rendered_prompt', 'parsed_result', 'plan_prompt', 'plan_context')
),
relative_path TEXT NOT NULL,
media_type TEXT NOT NULL,
size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
sha256 TEXT,
created_at TEXT NOT NULL
```

#### scout_run

```sql
id TEXT PRIMARY KEY,
trigger_type TEXT NOT NULL CHECK (
  trigger_type IN ('startup', 'poll', 'worker_finished', 'task_mutation', 'lease_change', 'manual')
),
status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
started_at TEXT NOT NULL,
finished_at TEXT,
selected_job_id TEXT REFERENCES job(id) ON DELETE SET NULL,
selected_action TEXT CHECK (selected_action IN ('execution', 'review', 'retry', 'consolidation')),
selected_task_id TEXT,
selected_reason TEXT NOT NULL DEFAULT '',
candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
terminal_count INTEGER NOT NULL DEFAULT 0 CHECK (terminal_count >= 0),
summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
error_message TEXT
```

#### review_checkpoint

```sql
id TEXT PRIMARY KEY,
task_id TEXT NOT NULL,
pr_url TEXT NOT NULL,
head_sha TEXT NOT NULL,
latest_review_summary_id TEXT,
latest_conversation_comment_id TEXT,
checks_fingerprint TEXT NOT NULL DEFAULT '',
merge_state TEXT NOT NULL DEFAULT '',
recorded_at TEXT NOT NULL,
source_attempt_id TEXT REFERENCES execution_attempt(id) ON DELETE SET NULL
```

### Required Uniqueness And Index Rules

- `job`: unique active `dedupe_key` across `queued`, `leased`, and `running`
- `execution_attempt`: unique `(job_id, attempt_number)`
- `lease`: unique active `(resource_type, resource_key)` where `released_at IS NULL`
- `worker`: unique `slot`
- `artifact`: unique `relative_path`
- `review_checkpoint`: unique `(task_id, pr_url)`

Required indexes:

- `job(status, created_at)`
- `job(task_id, created_at desc)`
- `execution_attempt(job_id, started_at desc)`
- `execution_attempt(status, started_at desc)`
- `execution_attempt_event(execution_attempt_id, created_at asc)`
- `lease(expires_at)`
- `worker(status)`
- `scout_run(started_at desc)`
- `review_checkpoint(recorded_at desc)`

## Migrations

Migrations are forward-only SQL files applied automatically on `foreman serve`.

Initial migration plan:

- `0001_init_core.sql`
- `0002_scout_run.sql`
- `0003_review_checkpoint.sql`
- `0004_memory_tables.sql`
- `0005_learning_fts.sql`

Foreman uses a `schema_migration` table to track applied migrations and checksums.

Legacy import is separate and not part of the migration chain.

## Legacy Import

Legacy import copies learnings and history from the old SQLite database into the new workspace `foreman.db`.

This is a one-off operation triggered manually and is not tracked as an ongoing synchronization concern.

The target workspace must already have been initialized with `foreman init` so that `foreman.db` and the required tables exist before import runs.

Import preconditions:

- destination `learning`, `history_step`, and `history_step_repo` tables must be empty
- if any of those destination tables already contain rows, import must fail instead of merging or overwriting
- import is not treated as idempotent in v1
- if import fails partway through, the operation must roll back the transaction and leave the destination unchanged

## HTTP API

All endpoints are workspace-scoped because one process serves exactly one workspace.

### Main Endpoints

- `GET /api/status`
- `GET /api/tasks`
- `GET /api/tasks/:taskId`
- `GET /api/queue`
- `GET /api/jobs/:jobId`
- `GET /api/attempts`
- `GET /api/attempts/:attemptId`
- `GET /api/attempts/:attemptId/logs`
- `GET /api/attempts/:attemptId/logs/stream`
- `GET /api/workers`
- `GET /api/workers/:workerId/logs/stream`
- `GET /api/history`
- `GET /api/learnings`
- `GET /api/scout/runs`
- `POST /api/scheduler/start`
- `POST /api/scheduler/pause`
- `POST /api/scheduler/stop`
- `POST /api/scout/run`

### Endpoint Contracts

#### `GET /api/status`

Returns:

```json
{
  "workspace": {
    "name": "foo",
    "root": "/abs/path/to/workspaces/foo"
  },
  "scheduler": {
    "status": "running",
    "workerConcurrency": 4,
    "scoutPollIntervalSeconds": 60,
    "lastScoutRunAt": "2026-03-14T12:00:00Z",
    "nextScoutPollAt": "2026-03-14T12:01:00Z"
  },
  "integrations": {
    "taskSystem": {"type": "linear", "status": "ok"},
    "reviewSystem": {"type": "github", "status": "ok"},
    "runner": {"type": "opencode", "status": "ok"}
  },
  "repos": {
    "count": 3,
    "keys": ["product-app", "shared-lib", "tools"]
  }
}
```

#### `GET /api/tasks`

Query params:

- `state` optional normalized state filter
- `search` optional substring search against id/title
- `limit` optional positive integer

Returns:

```json
{
  "tasks": [
    {
      "id": "ENG-1234",
      "provider": "linear",
      "title": "Add dashboard filtering",
      "state": "ready",
      "providerState": "Todo",
      "priority": "high",
      "repo": "product-app",
      "updatedAt": "2026-03-14T12:00:00Z",
      "url": "https://linear.app/..."
    }
  ]
}
```

#### `GET /api/tasks/:taskId`

Returns the full normalized task and all current task comments:

```json
{
  "task": {
    "id": "ENG-1234",
    "provider": "linear",
    "providerId": "abc123",
    "title": "Add dashboard filtering",
    "description": "...",
    "state": "in_review",
    "providerState": "In Review",
    "priority": "high",
    "labels": ["Agent"],
    "assignee": "me",
    "repo": "product-app",
    "branchName": "eng-1234",
    "dependencies": {
      "taskIds": [],
      "baseTaskId": null,
      "branchNames": []
    },
    "artifacts": [],
    "updatedAt": "2026-03-14T12:00:00Z",
    "url": "https://linear.app/..."
  },
  "comments": []
}
```

#### `GET /api/queue`

Returns current jobs in newest-first order:

```json
{
  "jobs": [
    {
      "id": "01H...",
      "taskId": "ENG-1234",
      "action": "execution",
      "status": "queued",
      "priorityRank": 2,
      "repoKey": "product-app",
      "createdAt": "2026-03-14T12:00:00Z"
    }
  ]
}
```

#### `GET /api/jobs/:jobId`

Returns one job with its latest attempt summary and artifacts:

```json
{
  "job": {
    "id": "01H...",
    "taskId": "ENG-1234",
    "action": "execution",
    "status": "running",
    "priorityRank": 2,
    "repoKey": "product-app",
    "baseBranch": "main",
    "selectionReason": "highest priority ready task",
    "createdAt": "2026-03-14T12:00:00Z",
    "updatedAt": "2026-03-14T12:00:05Z"
  },
  "latestAttempt": {
    "id": "01H...",
    "status": "running",
    "startedAt": "2026-03-14T12:00:10Z"
  },
  "artifacts": []
}
```

#### `GET /api/attempts`

Query params:

- `status`
- `jobId`
- `limit`

Returns recent attempts newest-first:

```json
{
  "attempts": [
    {
      "id": "01H...",
      "jobId": "01H...",
      "workerId": "01H...",
      "attemptNumber": 1,
      "runnerName": "opencode",
      "runnerModel": "openai/gpt-5.4",
      "runnerVariant": "high",
      "status": "running",
      "startedAt": "2026-03-14T12:00:10Z",
      "finishedAt": null,
      "summary": ""
    }
  ]
}
```

#### `GET /api/attempts/:attemptId`

Returns one attempt, its ordered events, and its artifacts:

```json
{
  "attempt": {
    "id": "01H...",
    "jobId": "01H...",
    "workerId": "01H...",
    "attemptNumber": 1,
    "runnerName": "opencode",
    "runnerModel": "openai/gpt-5.4",
    "runnerVariant": "high",
    "status": "running",
    "startedAt": "2026-03-14T12:00:10Z",
    "finishedAt": null,
    "exitCode": null,
    "signal": null,
    "summary": ""
  },
  "events": [],
  "artifacts": []
}
```

#### `GET /api/workers`

Returns current worker slots, statuses, and any active attempt ids:

```json
{
  "workers": [
    {
      "id": "01H...",
      "slot": 1,
      "status": "running",
      "currentAttemptId": "01H...",
      "lastHeartbeatAt": "2026-03-14T12:00:20Z"
    }
  ]
}
```

#### `GET /api/history`

Returns semantic history entries newest-first.

#### `GET /api/learnings`

Query params:

- `search`
- `repo`
- `limit`
- `offset`

Returns learnings from `foreman.db`.

#### `GET /api/scout/runs`

Returns recent `scout_run` rows newest-first:

```json
{
  "runs": [
    {
      "id": "01H...",
      "triggerType": "poll",
      "status": "completed",
      "startedAt": "2026-03-14T12:00:00Z",
      "finishedAt": "2026-03-14T12:00:01Z",
      "selectedAction": "review",
      "selectedTaskId": "ENG-1234",
      "candidateCount": 12,
      "activeCount": 8,
      "terminalCount": 4
    }
  ]
}
```

#### `POST /api/scheduler/start`

Request body: optional empty JSON object.

Semantics:

- starts or resumes scheduling
- preserves queued jobs
- does not interrupt running attempts

Response:

```json
{
  "scheduler": {
    "status": "running"
  }
}
```

#### `POST /api/scheduler/pause`

Request body: optional empty JSON object.

Semantics:

- stops Scout and stops queueing or leasing new jobs
- allows already running attempts to continue
- preserves queued jobs

Response:

```json
{
  "scheduler": {
    "status": "paused"
  }
}
```

#### `POST /api/scheduler/stop`

Request body: optional empty JSON object.

Semantics:

- stops Scout and stops queueing or leasing new jobs
- kills all running attempts
- releases active leases for killed attempts
- preserves queued jobs

Response:

```json
{
  "scheduler": {
    "status": "stopped"
  }
}
```

#### `POST /api/scout/run`

Request body:

```json
{
  "trigger": "manual"
}
```

Response:

```json
{
  "scout": {
    "status": "scheduled",
    "trigger": "manual"
  }
}
```

### Log Endpoints

- `GET /api/attempts/:attemptId/logs`
  - returns raw `text/plain` log contents from the log file
- `GET /api/attempts/:attemptId/logs/stream`
  - streams log output from the attempt log file using SSE framing
  - log lines are emitted as raw line payloads, not JSON line objects
- `GET /api/workers/:workerId/logs/stream`
  - streams the active attempt log for a worker
  - emits metadata events when the worker switches attempts

### SSE

Use `text/event-stream`.

Recommended event types:

- `log`
- `attempt_changed`
- `ping`
- `scheduler_status_changed`
- `worker_updated`

`log` events use raw log lines as the SSE `data:` payload. `attempt_changed`, `scheduler_status_changed`, and `worker_updated` may use compact JSON payloads.

### Error Shape

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Human-readable message"
  }
}
```

## Open Implementation Work

This document locks product and architecture decisions. The remaining work is implementation detail:

- exact `zod` schemas
- exact SQL DDL and indexes
- exact template/fragment contents
- final HTTP pagination/filter polish beyond the contracts above

Those should follow this spec rather than redefine it.
