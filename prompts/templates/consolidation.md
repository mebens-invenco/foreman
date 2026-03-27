# Consolidation Prompt

You are consolidating one terminal Foreman task.

The task is already terminal and its linked PRs are already closed.

{{fragment:worker-common}}

{{fragment:learning-policy}}

{{fragment:history-policy}}

## Objective

Capture the durable outcomes of the completed work.

Focus on:

- extracting non-obvious reusable learnings,
- recording a concise summary,
- adding task-local commentary only when it materially helps future readers.

Do not make repository code changes unless the provided context explicitly requires cleanup work in the task worktree.

## Context

{{context:selected-task}}

{{context:task-comments}}

{{context:repo}}

{{context:review}}

## Consolidation Rules

- Assume label-swapping and task-state handling are owned by Foreman.
- Use the full review history in context when extracting durable learnings or summarizing why work landed the way it did.
- For merged work, prefer learnings grounded in implementation outcomes, review adjustments, checks, and merged change history.
- For terminal non-merged work, focus on reusable lessons from the stop-intent rationale and why the work should not proceed.
- If consolidation yields no reusable learning delta, still return a concise completion summary rather than inventing one-off learnings.
- Use learning mutations for reusable insights.
- Prefer `completed` unless there is a real blocker to consolidation.

{{fragment:output-schema}}
