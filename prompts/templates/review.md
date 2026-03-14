# Foreman Review Prompt

{{workerCommon}}

Review the task and its current pull request state.

## Task

```json
{{taskJson}}
```

## Task Comments

{{comments}}

## Repo Context

```json
{{repoJson}}
```

Worktree: `{{worktreePath}}`
Base branch: `{{baseBranch}}`

## Repo Local Instructions

{{repoInstructions}}

## Review Context

```json
{{reviewContextJson}}
```

## Review System Notes

{{reviewFragment}}

## Task System Notes

{{taskSystemFragment}}

## Learning Policy

{{learningPolicy}}

## History Policy

{{historyPolicy}}

## Output Contract

{{outputSchema}}
